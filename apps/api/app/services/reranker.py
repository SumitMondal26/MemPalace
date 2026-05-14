"""LLM-as-judge reranker — precision step on top of vector retrieval.

Why this exists
---------------
Vector retrieval is recall-optimized: it pulls a wide net of candidates that
are *semantically near* the query. Within that net, the top-k are ranked by
cosine similarity — geometric distance between two embedding vectors,
computed independently of each other.

That's a problem when two chunks have almost-equal similarity. Live example
(commit history, single-turn-pronoun-he case):
    [1] "Sumit is 28 years old"        @ similarity 0.45
    [2] "Eijjuu is 25 years old"       @ similarity 0.44
For "how old is he?", these are essentially tied — the embedder can't see
the gendered pronoun. The LLM downstream sees them ranked [1], [2] and
sometimes cites [2] confidently.

Reranking fixes this by sending top-N (e.g. 8) candidates + the query to a
second LLM call that sees ALL candidates AND the query together. The judge
can reason "this question contains 'he', this chunk is about Sumit (male),
this one is about Eijjuu (female), so Sumit is the better match". Then it
returns ranked indices. We reorder the chunk list and pass top-K (e.g. 5)
into the prompt.

Design
------
- LLM-as-judge (gpt-4o-mini), not a cross-encoder. Reason: cross-encoders
  need a Python ML dep + model download (~400MB for bge-reranker-base).
  LLM-as-judge is zero-infra, ~$0.0001 per call, and gpt-4o-mini is strong
  enough to reason about pronouns/disambiguation. Swap to a cross-encoder
  later if cost or latency demands.
- JSON output mode (constrains the model to return parseable {"ranked": [...]}).
- Defensive: any failure (parse error, missing/wrong indices, API error)
  falls back to the original ordering. Reranker can never break /chat.
- Skip when there's <2 candidates (nothing to rerank).
- Skip when the top candidate's similarity is more than 0.10 above second
  (clear winner — reranking would just spend money to confirm the obvious).
"""

from __future__ import annotations

import json
import time
from dataclasses import dataclass, field

from openai import AsyncOpenAI

from ..config import settings

RERANK_SYSTEM_PROMPT = """You re-rank retrieved memory chunks for a user's question.

You receive a question and a numbered list of candidate chunks. Your job is to return the chunks ordered from MOST useful for answering the question to LEAST useful.

Rules:
- Read each chunk in full. The vector retriever may have ranked them roughly by topical similarity, but it cannot resolve pronouns, gender, or specific entity matches.
- Prefer chunks that DIRECTLY answer the question. A chunk that mentions the topic is worse than a chunk that contains the answer.
- For pronoun questions ("he", "she", "they"), match the gender/identity from the chunks themselves — don't assume.
- If a chunk is irrelevant to the question, rank it last but still include it (we'll trim downstream).
- Output ONLY a JSON object: {"ranked": [<integer indices>]}. The list must contain every input index exactly once. No prose, no markdown.
""".strip()

# Skip the rerank call when the top candidate's similarity is more than this
# much above the second. Vector retrieval has already won.
RERANK_AMBIGUITY_GAP = 0.10

# Cap candidates we send to the judge. More than this and the prompt gets
# long, latency climbs, and the model loses track of indices. Top-8 covers
# the realistic "second-rank should have been first" failures.
RERANK_MAX_CANDIDATES = 8


@dataclass
class RerankResult:
    chunks: list[dict]                # reordered, top_k applied
    was_reranked: bool                # True only if we actually called the LLM
    skip_reason: str | None = None    # human-readable skip cause, or None
    elapsed_ms: int = 0
    prompt_tokens: int = 0
    completion_tokens: int = 0
    # The original→reranked index map, for /insights drill-down. Each entry is
    # (original_rank, reranked_rank, chunk_id) so the UI can show "what moved".
    movement: list[tuple[int, int, str]] = field(default_factory=list)


def _should_skip(candidates: list[dict]) -> str | None:
    if len(candidates) < 2:
        return "too few candidates"
    sims = [(c.get("similarity") or 0.0) for c in candidates]
    if (sims[0] - sims[1]) > RERANK_AMBIGUITY_GAP:
        return "clear winner (gap > 0.10)"
    return None


def _build_rerank_messages(query: str, candidates: list[dict]) -> list[dict]:
    """Format candidates with stable indices the model must echo back."""
    lines = []
    for i, c in enumerate(candidates):
        # Truncate each chunk to keep total prompt tokens bounded. The judge
        # mostly needs the gist, not the full text.
        preview = (c.get("content") or "")[:400].replace("\n", " ")
        lines.append(f"[{i}] {preview}")
    candidates_block = "\n".join(lines)
    user = (
        f"Question: {query}\n\n"
        f"Candidates:\n{candidates_block}\n\n"
        f"Return JSON: {{\"ranked\": [<indices in best-to-worst order>]}}"
    )
    return [
        {"role": "system", "content": RERANK_SYSTEM_PROMPT},
        {"role": "user", "content": user},
    ]


def _parse_ranked(raw: str, n: int) -> list[int] | None:
    """Extract and validate the ranked index list. None on any defect."""
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
        ranked = obj.get("ranked")
        if not isinstance(ranked, list):
            return None
        as_ints = [int(x) for x in ranked]
        if len(as_ints) != n:
            return None
        if set(as_ints) != set(range(n)):
            return None
        return as_ints
    except (ValueError, TypeError):
        return None


async def rerank_chunks(
    openai: AsyncOpenAI,
    query: str,
    candidates: list[dict],
    top_k: int,
) -> RerankResult:
    """Rerank `candidates` by LLM judgment, return top_k.

    Skips the LLM call when the result is obvious or impossible. Always
    returns something — even on total failure, falls back to the original
    ordering trimmed to top_k.
    """
    t0 = time.perf_counter()
    skip = _should_skip(candidates)
    if skip is not None:
        return RerankResult(
            chunks=candidates[:top_k],
            was_reranked=False,
            skip_reason=skip,
            elapsed_ms=int((time.perf_counter() - t0) * 1000),
        )

    sent = candidates[:RERANK_MAX_CANDIDATES]
    n = len(sent)
    messages = _build_rerank_messages(query, sent)

    prompt_tokens = 0
    completion_tokens = 0
    ranked: list[int] | None = None
    try:
        resp = await openai.chat.completions.create(
            model=settings.openai_chat_model,
            messages=messages,
            temperature=0.0,
            response_format={"type": "json_object"},
            # Each index is 1-2 chars + ", "; 8 indices easily fits in 80.
            max_tokens=80,
        )
        if resp.usage:
            prompt_tokens = resp.usage.prompt_tokens or 0
            completion_tokens = resp.usage.completion_tokens or 0
        if resp.choices:
            ranked = _parse_ranked(resp.choices[0].message.content or "", n)
    except Exception:
        ranked = None

    elapsed_ms = int((time.perf_counter() - t0) * 1000)

    if ranked is None:
        # Fall back to original order — never break /chat.
        return RerankResult(
            chunks=candidates[:top_k],
            was_reranked=False,
            skip_reason="rerank parse/api failure",
            elapsed_ms=elapsed_ms,
            prompt_tokens=prompt_tokens,
            completion_tokens=completion_tokens,
        )

    reordered = [sent[i] for i in ranked]
    # Append any candidates beyond MAX_CANDIDATES untouched at the bottom.
    # They were never reranked but shouldn't be dropped before top_k cut.
    tail = candidates[RERANK_MAX_CANDIDATES:]
    full = reordered + tail
    movement = [
        (orig_rank, new_rank, sent[orig_rank].get("id", ""))
        for new_rank, orig_rank in enumerate(ranked)
    ]
    return RerankResult(
        chunks=full[:top_k],
        was_reranked=True,
        skip_reason=None,
        elapsed_ms=elapsed_ms,
        prompt_tokens=prompt_tokens,
        completion_tokens=completion_tokens,
        movement=movement,
    )
