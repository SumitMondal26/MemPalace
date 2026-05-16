"""The agent loop — hand-written, no framework.

Shape:

    messages = [system, ...history, user_question]
    for iter in range(MAX_ITERATIONS):
        response = openai.chat.completions.create(messages, tools=TOOL_SPECS)
        msg = response.choices[0].message
        if msg.tool_calls:
            messages.append(msg)                      # the assistant turn
            for call in msg.tool_calls:
                result = await dispatch_tool(call.name, call.args, ctx)
                messages.append({                     # the tool result turn
                    "role": "tool",
                    "tool_call_id": call.id,
                    "content": json.dumps(result.result),
                })
            # next iteration — model sees the results, decides what to do
        else:
            # no tool calls = final answer
            yield AgentEvent.final(msg.content)
            break
    else:
        yield AgentEvent.iter_cap_hit()

That's it. ~30 real lines of logic. Every framework ("LangChain agents",
"AutoGPT", "OpenAI Assistants") wraps this same loop. Reading the loop
end-to-end is what teaches you what's actually happening.

Three guards baked in:
  - MAX_ITERATIONS (cost ceiling): a buggy / chatty agent can otherwise
    burn $$$ in a runaway loop.
  - per-tool dispatch returns ok=False on exception: errors land in the
    LLM's view as tool messages, not as Python crashes that kill /agent.
  - max_tokens on the LLM call: bounds per-turn output cost.

The loop is async-iterable so the router can yield SSE events as they
happen — tool_call / tool_result / token / done. Without this, the user
stares at "Thinking..." for 10 seconds while the agent runs three tool
calls. With it, the trace UI fills in real-time and the user sees the
reasoning unfold.
"""

from __future__ import annotations

import json
import time
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Literal

from openai import AsyncOpenAI

from ..config import settings
from .tools import TOOL_SPECS, ToolContext, dispatch_tool


def _today_header() -> str:
    """Datetime-aware preamble prepended to the system prompt.

    Models have no built-in concept of "today". Without this, questions
    like "how much time until X's birthday" or "how old is X now" fail
    because the model can't compute durations against the present.
    Computed per-request so it's always current.
    """
    now = datetime.now()
    return f"TODAY IS: {now.strftime('%A, %Y-%m-%d')}"

# Hard ceiling on agent reasoning steps. Each step is one LLM call +
# (optionally) one tool dispatch per requested tool. 5 → at most 5 LLM
# calls per question. Empirically 2-3 covers most multi-hop questions.
MAX_ITERATIONS = 5

# Per-iteration LLM output cap. The LLM is choosing tools or writing the
# final answer; it doesn't need 4096 tokens for either. 800 fits a
# detailed final answer with citations.
MAX_TOKENS_PER_ITER = 800

AGENT_SYSTEM_PROMPT = """You are Mem Palace, an assistant that explores a user's personal memory graph.

You have READ tools:
  - search_memory(query, k): semantic search returning chunks with node ids + previews
  - read_node(node_id): full content of one node
  - list_clusters(): all topic clusters in the workspace
  - read_cluster_members(cluster_id): nodes in a cluster

And ONE WRITE tool (proposal-based — does NOT modify the graph directly):
  - create_note(title, content, source_node_ids, reason):
      Queues a proposal to create a new note. The user reviews and
      approves before anything is created. Use whenever the user asks
      you to save, write down, remember, summarize, jot, or otherwise
      capture something — covers summaries, lists, journal entries,
      plain notes. Don't volunteer proposals unprompted — answer the
      user's question first; only propose a note if they asked for one.

How to work:
- Plan briefly. If a question can be answered with one tool call, just do it.
- If you need more context after a search, call read_node on the most relevant result.
- Cite which nodes you used. Reference them inline by title in your final answer.
- If your tools return nothing relevant, say so honestly. Do NOT invent facts.
- Be concise. The user wants the answer, not a transcript of your reasoning.
- When you have enough to answer, just answer — don't keep searching for completeness.
- If you propose a write, your final answer should mention the proposal and tell the user it's awaiting their approval in the chat panel.
""".strip()


# ---------------------------------------------------------------------------
# Event types — the agent loop yields these; router serializes them as SSE.
# ---------------------------------------------------------------------------


@dataclass
class AgentToolCall:
    iter: int
    name: str
    args: dict
    tool_call_id: str


@dataclass
class AgentToolResult:
    iter: int
    name: str
    tool_call_id: str
    ok: bool
    result_preview: str
    elapsed_ms: int


@dataclass
class AgentFinalAnswer:
    content: str
    iter_used: int


@dataclass
class AgentDone:
    iterations: int
    hit_iter_cap: bool
    prompt_tokens: int
    completion_tokens: int
    tool_calls: list[dict] = field(default_factory=list)
    # Write proposals queued by tools like create_note. Empty for
    # read-only agent runs. Router writes one agent_actions row per entry
    # and surfaces them to the user via the SSE done event for approval.
    proposals: list[dict] = field(default_factory=list)


AgentEvent = AgentToolCall | AgentToolResult | AgentFinalAnswer | AgentDone


def _result_preview(result: Any, n: int = 240) -> str:
    """Bounded string view of a tool result for the SSE event + log row."""
    try:
        s = json.dumps(result, default=str)
    except Exception:
        s = str(result)
    return s if len(s) <= n else s[: n - 1] + "…"


async def run_agent(
    openai: AsyncOpenAI,
    ctx: ToolContext,
    question: str,
    history: list[dict] | None = None,
) -> AsyncIterator[AgentEvent]:
    """Run the agent loop, yielding events as they happen.

    Caller (router) is responsible for serializing each event into the SSE
    response. We don't deal with HTTP here.
    """
    history = history or []
    messages: list[dict] = [
        {
            "role": "system",
            "content": f"{_today_header()}\n\n{AGENT_SYSTEM_PROMPT}",
        },
        *history,
        {"role": "user", "content": question},
    ]

    total_prompt_tokens = 0
    total_completion_tokens = 0
    tool_call_log: list[dict] = []   # for the chat_logs row at the end
    final_content: str | None = None
    iters_used = 0

    for iter_idx in range(MAX_ITERATIONS):
        iters_used = iter_idx + 1
        resp = await openai.chat.completions.create(
            model=settings.openai_chat_model,
            messages=messages,
            tools=TOOL_SPECS,
            tool_choice="auto",
            temperature=0.2,
            max_tokens=MAX_TOKENS_PER_ITER,
        )
        if resp.usage:
            total_prompt_tokens += resp.usage.prompt_tokens or 0
            total_completion_tokens += resp.usage.completion_tokens or 0

        msg = resp.choices[0].message
        tool_calls = msg.tool_calls or []

        # Final answer path: no tool calls → the model is done.
        if not tool_calls:
            final_content = msg.content or ""
            break

        # Tool-call path: append the assistant turn (with tool_calls intact)
        # then dispatch each tool and append a "tool" role message per result.
        # OpenAI's API requires this exact structure on the next iteration.
        messages.append(
            {
                "role": "assistant",
                "content": msg.content,
                "tool_calls": [
                    {
                        "id": tc.id,
                        "type": "function",
                        "function": {
                            "name": tc.function.name,
                            "arguments": tc.function.arguments,
                        },
                    }
                    for tc in tool_calls
                ],
            }
        )

        for tc in tool_calls:
            try:
                args = json.loads(tc.function.arguments or "{}")
            except json.JSONDecodeError:
                args = {}

            yield AgentToolCall(
                iter=iter_idx,
                name=tc.function.name,
                args=args,
                tool_call_id=tc.id,
            )

            res = await dispatch_tool(tc.function.name, args, ctx)
            preview = _result_preview(res.result)

            yield AgentToolResult(
                iter=iter_idx,
                name=res.name,
                tool_call_id=tc.id,
                ok=res.ok,
                result_preview=preview,
                elapsed_ms=res.elapsed_ms,
            )

            tool_call_log.append(
                {
                    "iter": iter_idx,
                    "name": res.name,
                    "args": args,
                    "result_preview": preview,
                    "ms": res.elapsed_ms,
                    "ok": res.ok,
                }
            )

            # Feed result back to the model on the next iteration.
            messages.append(
                {
                    "role": "tool",
                    "tool_call_id": tc.id,
                    "content": _result_preview(res.result, n=4000),
                }
            )

    # Loop exited — either we got a final answer or we hit the iteration cap.
    hit_cap = final_content is None
    if hit_cap:
        # Force a final answer with what we have. One last LLM call WITHOUT
        # tools so the model is required to summarize, not search more.
        # Honest behavior: tell the user we capped instead of pretending
        # the agent was confident.
        forced = await openai.chat.completions.create(
            model=settings.openai_chat_model,
            messages=messages
            + [
                {
                    "role": "user",
                    "content": (
                        "You've reached the tool-call limit. Summarize what you "
                        "found in your tool results so far. If you couldn't "
                        "answer, say so plainly."
                    ),
                }
            ],
            temperature=0.2,
            max_tokens=MAX_TOKENS_PER_ITER,
        )
        if forced.usage:
            total_prompt_tokens += forced.usage.prompt_tokens or 0
            total_completion_tokens += forced.usage.completion_tokens or 0
        final_content = (forced.choices[0].message.content or "").strip()

    yield AgentFinalAnswer(content=final_content, iter_used=iters_used)
    # Snapshot the proposals at the end of the loop. They were appended
    # by write-tool dispatch into the shared ToolContext during the run;
    # we hand them off to the router, then clear so a re-entered attempt
    # (P3.2 reflection retry) starts with an empty queue.
    proposals_snapshot = list(ctx.proposals)
    ctx.proposals.clear()
    yield AgentDone(
        iterations=iters_used,
        hit_iter_cap=hit_cap,
        prompt_tokens=total_prompt_tokens,
        completion_tokens=total_completion_tokens,
        tool_calls=tool_call_log,
        proposals=proposals_snapshot,
    )
