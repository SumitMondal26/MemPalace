"""POST /agent — agentic chat. Multi-step LLM-tools loop, streamed over SSE.

Differences from /chat:
  - Multi-step: model can call tools (search_memory, read_node, etc.) and
    iterate. /chat does a single retrieval + single LLM call.
  - SSE protocol additions: `tool_call`, `tool_result`. Same `done`
    envelope so existing UI bits (cost, latency) work unchanged.
  - Final answer is delivered as a single `final` event rather than
    streamed token-by-token. Streaming a tool-using completion adds
    complexity (token interleaving with tool_call events) for marginal
    UX gain on a 5-15s agent run that already has rich progress events.

Same observability path as /chat: writes one `chat_logs` row per turn,
with `is_agent=true` + `agent_tool_calls` jsonb capturing the full tool
trace. /insights surfaces both /chat and /agent rows.

Cost note: a 3-iteration agent uses ~3× the input tokens of /chat
(message history grows with every tool result). Latency similarly. The
trade is reasoning depth for resource use — surfaced in the trace so
the user can see what they're paying for.
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

        yield _sse("stage", {"label": "Agent reasoning", "elapsed_ms": ms()})

        # Aggregates we'll fill from the AgentDone event at the end.
        final_answer = ""
        iterations = 0
        hit_cap = False
        prompt_tokens = 0
        completion_tokens = 0
        tool_call_log: list[dict] = []
        cited_node_ids: set[str] = set()

        async for evt in run_agent(openai, ctx, body.question, history):
            if isinstance(evt, AgentToolCall):
                yield _sse(
                    "tool_call",
                    {
                        "iter": evt.iter,
                        "name": evt.name,
                        "args": evt.args,
                        "tool_call_id": evt.tool_call_id,
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
                        "elapsed_ms": ms(),
                    },
                )
                # Try to extract cited node ids for the chat_logs row.
                # Robust to malformed previews — best-effort.
                try:
                    if evt.name == "search_memory" and evt.ok:
                        # The full results aren't in the preview; we'd have to
                        # plumb them back. For v1 we'll let the agent's
                        # answer text serve as the citation source and skip
                        # auto-extraction.
                        pass
                except Exception:
                    pass
            elif isinstance(evt, AgentFinalAnswer):
                final_answer = evt.content
                yield _sse(
                    "final",
                    {"content": evt.content, "iter_used": evt.iter_used},
                )
            elif isinstance(evt, AgentDone):
                iterations = evt.iterations
                hit_cap = evt.hit_iter_cap
                prompt_tokens = evt.prompt_tokens
                completion_tokens = evt.completion_tokens
                tool_call_log = evt.tool_calls

        total_ms = ms()
        cost_usd = _cost(
            settings.openai_chat_model, prompt_tokens, completion_tokens
        )

        # Build the cited_node_ids set from tool_call_log post-hoc so it
        # appears in chat_logs alongside /chat rows.
        for entry in tool_call_log:
            if entry.get("name") == "read_node":
                nid = (entry.get("args") or {}).get("node_id")
                if nid:
                    cited_node_ids.add(nid)

        yield _sse(
            "done",
            {
                "elapsed_ms": total_ms,
                "iterations": iterations,
                "hit_iter_cap": hit_cap,
                "prompt_tokens": prompt_tokens,
                "completion_tokens": completion_tokens,
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
