"""Query rewriter — turns a context-dependent follow-up into a standalone search query.

Why this exists
---------------
At generation time we already send the last N turns to the LLM, so the
*answerer* has full context. But at retrieval time we embed only the latest
user message — the *retriever* is blind to history. That breaks queries like:

    user: who is my girlfriend?
    asst: Eijuuu.
    user: how old is she?               ← embedding has no signal for "she"

The rewriter fixes that asymmetry. One cheap LLM call (gpt-4o-mini, no
streaming, ~300-700ms) takes the recent turns + latest question and emits a
standalone search query that names the entities. We embed *that* instead.

Design notes
------------
- Skipped when there is no history (single-turn case): rewriting "what is X?"
  is pointless work and wastes ~$0.0001.
- Returns a structured result so the caller can:
    - emit an SSE `rewrite` event for transparency
    - log original vs rewritten in chat_logs for debuggability
    - compute the rewrite's own token cost
- Defensive on the LLM output: if it returns junk we fall back to the
  original question rather than poison the retriever.
- Temperature 0 — this is a transformation, not a creative task.

Tradeoff
--------
~300-700ms latency + ~$0.0001 per turn that has history. Production systems
usually gate on a heuristic (does the query contain a pronoun? was there
prior turn?) but we run unconditionally on multi-turn for clarity in evals.
"""

from __future__ import annotations

import json
import time
from dataclasses import dataclass

from openai import AsyncOpenAI

from ..config import settings

REWRITE_SYSTEM_PROMPT = """You rewrite a user's latest message into a standalone search query for a vector database, using the prior conversation only when needed.

Rules:
- If the latest message already names the subject (no pronouns, no follow-up phrasing), return it unchanged.
- If it uses pronouns ("she", "it", "that", "the second one") or follow-up shorthand ("what about X?", "and his age?"), rewrite it to name the actual entity from the prior turns.
- Output ONLY a JSON object: {"query": "..."}. No prose, no markdown fence.
- Keep the rewrite short — it gets embedded as one query, not a sentence.
- If the prior context doesn't disambiguate, return the latest message unchanged.
""".strip()

# Cap the history we feed the rewriter — full history is wasteful and the
# answer is almost always derivable from the last 2-3 turns.
REWRITE_HISTORY_CAP = 4


@dataclass
class RewriteResult:
    original: str
    rewritten: str           # equals `original` when no rewrite happened
    was_rewritten: bool      # true only when the model produced a different string
    elapsed_ms: int
    prompt_tokens: int
    completion_tokens: int


def _build_rewrite_messages(
    question: str, history: list[dict]
) -> list[dict]:
    capped = history[-REWRITE_HISTORY_CAP:]
    transcript = "\n".join(
        f"{m['role']}: {m['content']}" for m in capped
    ) or "(no prior turns)"
    user_block = (
        f"Prior conversation:\n{transcript}\n\n"
        f"Latest user message: {question}\n\n"
        f"Return JSON only."
    )
    return [
        {"role": "system", "content": REWRITE_SYSTEM_PROMPT},
        {"role": "user", "content": user_block},
    ]


def _parse_query(raw: str, fallback: str) -> str:
    """Best-effort extraction of {"query": "..."} from the LLM output."""
    if not raw:
        return fallback
    text = raw.strip()
    # Strip a stray markdown fence if the model added one despite instructions.
    if text.startswith("```"):
        text = text.strip("`")
        # may have language tag like ```json
        if text.lower().startswith("json"):
            text = text[4:]
        text = text.strip()
    try:
        obj = json.loads(text)
        q = obj.get("query")
        if isinstance(q, str) and q.strip():
            return q.strip()
    except (ValueError, TypeError):
        pass
    return fallback


async def rewrite_query(
    openai: AsyncOpenAI,
    question: str,
    history: list[dict] | None,
) -> RewriteResult:
    """Rewrite `question` into a standalone search query using `history`.

    Skips the LLM call (zero cost) when there is no history.
    Falls back to `question` on any parse / API failure.
    """
    t0 = time.perf_counter()
    if not history:
        return RewriteResult(
            original=question,
            rewritten=question,
            was_rewritten=False,
            elapsed_ms=0,
            prompt_tokens=0,
            completion_tokens=0,
        )

    messages = _build_rewrite_messages(question, history)
    prompt_tokens = 0
    completion_tokens = 0
    rewritten = question

    try:
        resp = await openai.chat.completions.create(
            model=settings.openai_chat_model,
            messages=messages,
            temperature=0.0,
            response_format={"type": "json_object"},
            max_tokens=120,
        )
        if resp.usage:
            prompt_tokens = resp.usage.prompt_tokens or 0
            completion_tokens = resp.usage.completion_tokens or 0
        if resp.choices:
            rewritten = _parse_query(
                resp.choices[0].message.content or "", question
            )
    except Exception:
        # Never let the rewriter break the chat path.
        rewritten = question

    elapsed_ms = int((time.perf_counter() - t0) * 1000)
    return RewriteResult(
        original=question,
        rewritten=rewritten,
        was_rewritten=rewritten.strip() != question.strip(),
        elapsed_ms=elapsed_ms,
        prompt_tokens=prompt_tokens,
        completion_tokens=completion_tokens,
    )
