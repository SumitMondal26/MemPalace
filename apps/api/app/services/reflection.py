"""Reflection — LLM-as-judge over an agent's final answer.

Why this exists
---------------
The agent loop (P3.1) can produce confident-but-shallow answers. Common failure
modes we've observed:

  - The agent searches once, finds *some* relevant chunks, and answers without
    fetching the supporting nodes (so cites by title without context).
  - The agent answers from conversation memory without re-verifying with tools
    (we caught one of these live: "what does he like?" → answered correctly
    from the prior turn's history but with zero fresh tool calls — works
    today, breaks the moment the underlying data changes).
  - Multi-part questions get partial answers (asks for "X and what can he
    give as a gift" → answer covers X but skips the gift part).

A judge model catches these. Same shape as the reranker — a separate LLM call
that scores something the primary model produced. The judge sees the question,
the final answer, AND the tool log (so it can verify grounding). Returns a
1-5 score plus issues. Score below threshold + we haven't already retried =
one more agent attempt with the issues fed back.

Design
------
- gpt-4o-mini, temperature 0, JSON mode, max 200 tokens. Same triad as
  the rewriter and reranker — bounded shape, deterministic, cheap.
- Defensive: parse failure → score=5 (assume passes), no retry. Never
  forces a retry on a buggy judge output. The cost of a missed retry is
  low (the answer might be slightly worse); the cost of a forced retry
  on every malformed response is real money.
- Cap at 1 retry. A reflection-retry-reflection ping-pong loop would burn
  cost and rarely improve.
- Skip when no question/answer/tools (defensive — caller shouldn't ever
  hand us empty inputs but be safe).

Tradeoff
--------
+1 LLM call always when reflection is enabled (the judge), and another
agent run when it triggers retry. Worst case: 3-iter agent + judge +
3-iter retry + (skip second judge) = ~7 LLM calls vs the original 3.
2-3× cost on retries, ~1.3× cost on no-retry case. Worth it for the
quality lift on multi-part / hard questions.
"""

from __future__ import annotations

import json
import time
from dataclasses import dataclass
from typing import Any

from openai import AsyncOpenAI

from ..config import settings

JUDGE_SYSTEM_PROMPT = """You are a quality judge for a memory-search agent's answer.

You receive:
  - The user's question.
  - The agent's final answer.
  - A summary of the tool calls the agent made (search results, node reads, etc.).

Score the answer on a 1-5 rubric:
  5 — Perfect: directly answers every part of the question, grounded in the tool results, no invented facts.
  4 — Good: addresses the main question accurately and is grounded; minor omissions OK.
  3 — Mediocre: partially answers OR has thin grounding (could have used more tool data).
  2 — Bad: missing major parts of the question, or makes claims not in the tool results.
  1 — Very wrong: hallucinated, off-topic, or contradicts the tool results.

Also list specific issues (what's missing, ungrounded, or wrong) — empty when score >= 4.

Output ONLY a JSON object: {"score": int, "issues": "string", "should_retry": bool}.
Set should_retry=true when score < 4 AND a retry could plausibly improve the answer (i.e. issues are addressable, not "the data simply doesn't exist"). No prose, no markdown.
""".strip()


@dataclass
class ReflectionJudgment:
    score: int                # 1-5
    issues: str               # human-readable critique, empty when score >= 4
    should_retry: bool
    elapsed_ms: int
    prompt_tokens: int
    completion_tokens: int
    parse_failed: bool = False  # surfaced for /insights debugging


def _parse_judgment(raw: str) -> tuple[int, str, bool] | None:
    """Returns (score, issues, should_retry) or None on any defect."""
    if not raw:
        return None
    text = raw.strip()
    if text.startswith("```"):
        text = text.strip("`")
        if text.lower().startswith("json"):
            text = text[4:]
        text = text.strip()
    try:
        obj = json.loads(text)
        score = obj.get("score")
        if not isinstance(score, int) or not (1 <= score <= 5):
            return None
        issues = obj.get("issues") or ""
        if not isinstance(issues, str):
            issues = str(issues)
        should_retry = bool(obj.get("should_retry", False))
        return score, issues.strip()[:400], should_retry
    except (ValueError, TypeError):
        return None


def _summarize_tool_log(tool_log: list[dict], cap: int = 1500) -> str:
    """Short-form view of what the agent did, for the judge.

    Each entry: "iter=N name(args) → result_preview". Truncated to keep the
    judge prompt bounded — the judge needs to know *what data the agent had*
    to assess grounding, not the full transcript.
    """
    if not tool_log:
        return "(no tools called)"
    lines = []
    for entry in tool_log:
        name = entry.get("name", "?")
        args = entry.get("args") or {}
        args_str = ", ".join(
            f"{k}={(str(v)[:30] + '…') if len(str(v)) > 30 else v}"
            for k, v in args.items()
        )
        preview = (entry.get("result_preview") or "")[:200]
        ok = "" if entry.get("ok", True) else " [FAILED]"
        lines.append(f"  iter={entry.get('iter')} {name}({args_str}){ok}\n    → {preview}")
    out = "\n".join(lines)
    return out if len(out) <= cap else out[: cap - 1] + "…"


async def reflect_on_answer(
    openai: AsyncOpenAI,
    question: str,
    answer: str,
    tool_log: list[dict],
) -> ReflectionJudgment:
    """Score the agent's answer. Always returns a judgment — never raises.

    Defensive defaults: any failure path returns score=5 (assume passes,
    no retry). The cost of missing a retry on a bad answer is low; the
    cost of forcing retries on every transient API failure is real money.
    """
    t0 = time.perf_counter()

    if not question.strip() or not answer.strip():
        return ReflectionJudgment(
            score=5, issues="", should_retry=False,
            elapsed_ms=0, prompt_tokens=0, completion_tokens=0,
        )

    user = (
        f"Question: {question}\n\n"
        f"Agent's final answer:\n{answer}\n\n"
        f"Tool calls the agent made:\n{_summarize_tool_log(tool_log)}\n\n"
        f"Return JSON only."
    )

    prompt_tokens = 0
    completion_tokens = 0
    parsed: tuple[int, str, bool] | None = None
    try:
        resp = await openai.chat.completions.create(
            model=settings.openai_chat_model,
            messages=[
                {"role": "system", "content": JUDGE_SYSTEM_PROMPT},
                {"role": "user", "content": user},
            ],
            temperature=0.0,
            response_format={"type": "json_object"},
            max_tokens=200,
        )
        if resp.usage:
            prompt_tokens = resp.usage.prompt_tokens or 0
            completion_tokens = resp.usage.completion_tokens or 0
        if resp.choices:
            parsed = _parse_judgment(resp.choices[0].message.content or "")
    except Exception:
        parsed = None

    elapsed_ms = int((time.perf_counter() - t0) * 1000)

    if parsed is None:
        return ReflectionJudgment(
            score=5, issues="", should_retry=False,
            elapsed_ms=elapsed_ms,
            prompt_tokens=prompt_tokens, completion_tokens=completion_tokens,
            parse_failed=True,
        )

    score, issues, should_retry = parsed
    # Enforce the threshold here too — we don't trust the model's
    # should_retry flag in isolation. Both conditions must hold.
    actual_retry = should_retry and score < settings.reflection_retry_below
    return ReflectionJudgment(
        score=score,
        issues=issues,
        should_retry=actual_retry,
        elapsed_ms=elapsed_ms,
        prompt_tokens=prompt_tokens,
        completion_tokens=completion_tokens,
    )


def build_retry_feedback(prev_answer: str, judgment: ReflectionJudgment) -> str:
    """Construct the feedback message that goes to the agent's second attempt.

    Phrased as user feedback because (a) the model treats user-role
    messages as authoritative direction, and (b) the rejected answer is
    appended as an assistant turn just before this — same shape as a
    normal "I want you to retry with this guidance" exchange.
    """
    return (
        f"Your previous answer scored {judgment.score}/5 from a quality "
        f"check. Issues identified:\n\n{judgment.issues or '(none provided)'}\n\n"
        f"Please try again. Use additional tool calls if needed to address "
        f"the issues — don't repeat the same approach. Be specific and "
        f"ground every claim in actual tool results."
    )
