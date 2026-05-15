"""POST /agent — agentic chat. Multi-step LLM-tools loop, streamed over SSE.

Differences from /chat:
  - Multi-step: model can call tools (search_memory, read_node, etc.) and
    iterate. /chat does a single retrieval + single LLM call.
  - SSE protocol additions: `tool_call`, `tool_result`, `reflection`,
    `final`. Same `done` envelope so existing UI bits (cost, latency)
    work unchanged.
  - Final answer is delivered as a single `final` event rather than
    streamed token-by-token. Streaming a tool-using completion adds
    complexity (token interleaving with tool_call events) for marginal
    UX gain on a 5-15s agent run that already has rich progress events.

Reflection (P3.2):
  After the first attempt produces a final answer, an LLM judge scores
  it 1-5 on grounding + completeness. Score < threshold triggers ONE
  retry — same agent loop, but the history now contains the rejected
  answer + the judge's issues as a user-role feedback message. The
  agent typically does a different sequence of tool calls in response.
  Cap at 1 retry to prevent ping-pong.

  Every event in attempt 2 is tagged with `attempt: "retry"` so the UI
  can visually separate the two passes. The `final` event for the
  retry overwrites the answer bubble; the trace appends.

Same observability path as /chat: writes one `chat_logs` row per turn,
with `is_agent=true` + `agent_tool_calls` jsonb capturing both attempts'
tool traces + reflection columns. /insights surfaces both /chat and
/agent rows.

Cost note: a 3-iteration agent uses ~3× the input tokens of /chat. A
3-iter agent that triggers retry uses 5-7× (first attempt + judge +
retry). The judge is ~1 cheap LLM call; the retry is a whole second
agent run. Surfaced in the trace.
"""

import json
import time
from typing import Annotated, Literal

from fastapi import APIRouter, Depends
from fastapi.responses import StreamingResponse
from openai import AsyncOpenAI
from pydantic import BaseModel, Field
from supabase import Client

from ..config import settings
from ..deps import openai_client, supabase_user
from ..services.agent import (
    AgentDone,
    AgentFinalAnswer,
    AgentToolCall,
    AgentToolResult,
    run_agent,
)
from ..services.reflection import build_retry_feedback, reflect_on_answer
from ..services.tools import ToolContext

router = APIRouter()


# Per-token prices (USD), kept in sync with chat.py. Duplicated rather than
# imported because the chat router will move under a service module later.
_PRICE_PER_TOKEN: dict[str, tuple[float, float]] = {
    "gpt-4o-mini": (0.15 / 1_000_000, 0.60 / 1_000_000),
    "gpt-4o": (2.50 / 1_000_000, 10.00 / 1_000_000),
    "gpt-4-turbo": (10.00 / 1_000_000, 30.00 / 1_000_000),
}


def _cost(model: str, in_tok: int, out_tok: int = 0) -> float:
    rates = _PRICE_PER_TOKEN.get(model, (0.0, 0.0))
    return in_tok * rates[0] + out_tok * rates[1]


class AgentHistoryMessage(BaseModel):
    role: Literal["user", "assistant"]
    content: str


HISTORY_MAX_MESSAGES = 6


class AgentRequest(BaseModel):
    question: str = Field(..., min_length=1)
    history: list[AgentHistoryMessage] = Field(default_factory=list)


def _sse(event: str, data: object) -> str:
    return f"event: {event}\ndata: {json.dumps(data, default=str)}\n\n"


@router.post("/agent")
async def agent(
    body: AgentRequest,
    sb_user: Annotated[Client, Depends(supabase_user)],
    openai: Annotated[AsyncOpenAI, Depends(openai_client)],
):
    async def generate():
        t0 = time.perf_counter()

        def ms() -> int:
            return int((time.perf_counter() - t0) * 1000)

        # Resolve workspace once — same pattern as /chat.
        ws = (
            sb_user.table("workspaces")
            .select("id")
            .order("created_at", desc=False)
            .limit(1)
            .maybe_single()
            .execute()
        )
        workspace_id = ws.data["id"] if ws and ws.data else None
        if not workspace_id:
            yield _sse("done", {"error": "no workspace"})
            return

        ctx = ToolContext(
            sb_user=sb_user, openai=openai, workspace_id=workspace_id
        )
        history = [
            {"role": m.role, "content": m.content}
            for m in body.history[-HISTORY_MAX_MESSAGES:]
        ]

        # Cross-attempt accumulators. Tools log carries an "attempt" tag so
        # /insights replay shows which pass each call belongs to.
        first_answer = ""
        final_answer = ""
        iterations_total = 0
        hit_cap = False
        prompt_tokens_total = 0
        completion_tokens_total = 0
        tool_call_log: list[dict] = []

        # Reflection state — None when the judge didn't run (feature off /
        # no first-attempt answer).
        # `score_first` = judge's score of attempt 1 (set when reflection ran).
        # `score`        = SHIPPED answer's score (max of attempts when retried).
        # `issues`       = judge's issues on the REJECTED attempt — what
        #                  prompted the retry. Empty when no retry.
        reflection_score: int | None = None
        reflection_score_first: int | None = None
        reflection_issues: str = ""
        reflection_retried = False

        async def _stream_attempt(
            attempt_question: str,
            attempt_history: list[dict],
            attempt_label: str,
        ):
            """Run one full agent pass, yielding SSE events. Updates the
            outer accumulators via nonlocal — async generators can't return
            values cleanly, so closures over mutable state is the cleanest
            way to thread results back to the caller."""
            nonlocal first_answer, final_answer
            nonlocal iterations_total, hit_cap
            nonlocal prompt_tokens_total, completion_tokens_total
            nonlocal tool_call_log

            async for evt in run_agent(
                openai, ctx, attempt_question, attempt_history
            ):
                if isinstance(evt, AgentToolCall):
                    yield _sse(
                        "tool_call",
                        {
                            "iter": evt.iter,
                            "name": evt.name,
                            "args": evt.args,
                            "tool_call_id": evt.tool_call_id,
                            "attempt": attempt_label,
                            "elapsed_ms": ms(),
                        },
                    )
                elif isinstance(evt, AgentToolResult):
                    yield _sse(
                        "tool_result",
                        {
                            "iter": evt.iter,
                            "name": evt.name,
                            "tool_call_id": evt.tool_call_id,
                            "ok": evt.ok,
                            "result_preview": evt.result_preview,
                            "tool_ms": evt.elapsed_ms,
                            "attempt": attempt_label,
                            "elapsed_ms": ms(),
                        },
                    )
                elif isinstance(evt, AgentFinalAnswer):
                    final_answer = evt.content
                    if attempt_label == "first":
                        first_answer = evt.content
                    yield _sse(
                        "final",
                        {
                            "content": evt.content,
                            "iter_used": evt.iter_used,
                            "attempt": attempt_label,
                        },
                    )
                elif isinstance(evt, AgentDone):
                    iterations_total += evt.iterations
                    if evt.hit_iter_cap:
                        hit_cap = True
                    prompt_tokens_total += evt.prompt_tokens
                    completion_tokens_total += evt.completion_tokens
                    for entry in evt.tool_calls:
                        entry["attempt"] = attempt_label
                        tool_call_log.append(entry)

        # --- First attempt ---
        yield _sse("stage", {"label": "Agent reasoning", "elapsed_ms": ms()})
        async for evt in _stream_attempt(body.question, history, "first"):
            yield evt

        # --- Reflection + maybe retry ---
        if settings.reflection_enabled and first_answer:
            yield _sse(
                "stage",
                {"label": "Judging answer quality", "elapsed_ms": ms()},
            )
            judgment_first = await reflect_on_answer(
                openai, body.question, first_answer, tool_call_log
            )
            reflection_score_first = judgment_first.score
            # Provisional: shipped score = first score (updated after retry if any).
            reflection_score = judgment_first.score
            reflection_issues = judgment_first.issues
            prompt_tokens_total += judgment_first.prompt_tokens
            completion_tokens_total += judgment_first.completion_tokens

            yield _sse(
                "reflection",
                {
                    "score": judgment_first.score,
                    "score_first": judgment_first.score,
                    "issues": judgment_first.issues,
                    "retrying": judgment_first.should_retry,
                    "elapsed_ms": ms(),
                },
            )

            if judgment_first.should_retry:
                reflection_retried = True
                # Synthetic history for attempt 2: prior turns + the
                # question + the rejected answer + the judge's feedback.
                retry_history = history + [
                    {"role": "user", "content": body.question},
                    {"role": "assistant", "content": first_answer},
                ]
                feedback_question = build_retry_feedback(first_answer, judgment_first)
                yield _sse(
                    "stage",
                    {"label": "Retrying with feedback", "elapsed_ms": ms()},
                )
                async for evt in _stream_attempt(
                    feedback_question, retry_history, "retry"
                ):
                    yield evt
                # `final_answer` is now the retry's answer. Judge it too.
                retry_answer = final_answer
                # Tool log for the retry alone — pass to the judge so it
                # can verify the retry's grounding against just its own
                # fresh tool calls.
                retry_tool_log = [
                    t for t in tool_call_log if t.get("attempt") == "retry"
                ]
                yield _sse(
                    "stage",
                    {"label": "Judging retry quality", "elapsed_ms": ms()},
                )
                judgment_retry = await reflect_on_answer(
                    openai, body.question, retry_answer, retry_tool_log
                )
                prompt_tokens_total += judgment_retry.prompt_tokens
                completion_tokens_total += judgment_retry.completion_tokens

                # Ship the better-scoring attempt. Tie → prefer retry
                # (it had the feedback context, more likely to be better).
                if judgment_retry.score >= judgment_first.score:
                    reflection_score = judgment_retry.score
                    # Keep `reflection_issues` as the FIRST attempt's issues
                    # (what prompted the retry). The retry's issues, if any,
                    # are surfaced via the second `reflection` event below.
                else:
                    # First attempt won. Restore final_answer + re-emit
                    # the `final` event so the UI shows the right answer
                    # (the bubble currently shows the rejected retry).
                    final_answer = first_answer
                    yield _sse(
                        "final",
                        {
                            "content": first_answer,
                            "iter_used": 0,
                            "attempt": "first-restored",
                        },
                    )

                yield _sse(
                    "reflection",
                    {
                        # Second judgment refers to the RETRY's answer.
                        "score": judgment_retry.score,
                        "score_first": judgment_first.score,
                        "issues": judgment_retry.issues,
                        "retrying": False,  # no further retry
                        "attempt": "retry",
                        "elapsed_ms": ms(),
                    },
                )

        # --- Done ---
        cited_node_ids: set[str] = set()
        for entry in tool_call_log:
            if entry.get("name") == "read_node":
                nid = (entry.get("args") or {}).get("node_id")
                if nid:
                    cited_node_ids.add(nid)

        iterations = iterations_total
        prompt_tokens = prompt_tokens_total
        completion_tokens = completion_tokens_total
        total_ms = ms()
        cost_usd = _cost(
            settings.openai_chat_model, prompt_tokens, completion_tokens
        )

        yield _sse(
            "done",
            {
                "elapsed_ms": total_ms,
                "iterations": iterations,
                "hit_iter_cap": hit_cap,
                "prompt_tokens": prompt_tokens,
                "completion_tokens": completion_tokens,
                "reflection_score": reflection_score,
                "reflection_score_first": reflection_score_first,
                "reflection_retried": reflection_retried,
                "cost_usd": round(cost_usd, 6),
            },
        )

        # Persist for /insights. Best-effort — never break the stream.
        log_row = {
            "workspace_id": workspace_id,
            "question": body.question,
            "answer": final_answer,
            "prompt_messages": [],   # not captured for agent path (would balloon)
            "cited_node_ids": list(cited_node_ids),
            "model": settings.openai_chat_model,
            "embed_model": settings.openai_embedding_model,
            "retrieval_strategy": "agent",
            "k_requested": 0,
            "k_returned_raw": 0,
            "k_returned_filtered": 0,
            "history_size": len(history),
            "embed_ms": 0,
            "search_ms": 0,
            "llm_ms": total_ms,
            "total_ms": total_ms,
            "embed_tokens": 0,
            "prompt_tokens": prompt_tokens,
            "completion_tokens": completion_tokens,
            "cost_usd": round(cost_usd, 6),
            "status": "success" if final_answer else "failed",
            "is_agent": True,
            "agent_iterations": iterations,
            "agent_tool_calls": tool_call_log,
            "agent_hit_iter_cap": hit_cap,
            "reflection_score": reflection_score,
            "reflection_score_first": reflection_score_first,
            "reflection_retried": reflection_retried,
            "reflection_issues": reflection_issues or None,
        }
        try:
            sb_user.table("chat_logs").insert(log_row).execute()
        except Exception:
            pass

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )
