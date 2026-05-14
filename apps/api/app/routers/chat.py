"""POST /chat — retrieval-augmented chat, streamed over SSE.

SSE event types (ordered as emitted):

    event: stage     {label, elapsed_ms}
        Pipeline stage announcement. UI renders these as a live trace.

    event: sources   [{i, id, node_id, similarity, source, preview}, ...]
        Chunks that survived the relevance threshold filter.

    event: prompt    {messages, model, temperature}
        The exact array sent to OpenAI (including system + history + chunks).
        For debugging / learning. Privacy-sensitive — gate behind a flag in
        multi-tenant prod.

    event: token     "..."
        One delta from the LLM stream. Many of these.

    event: done      {elapsed_ms, total_tokens?, cost_usd?}
        Final event with totals.

After the stream finishes, the handler writes one row to `chat_logs` for
observability — visible at /insights.
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
from ..services.llm import build_chat_messages, stream_chat_messages
from ..services.retrieval import embed_query, search_chunks_with_neighbors

router = APIRouter()

RELEVANCE_THRESHOLD = 0.4

# OpenAI per-token prices (USD), as of 2026. Update as prices change.
PRICE_PER_TOKEN: dict[str, tuple[float, float]] = {
    # model: (input_per_token, output_per_token)
    "gpt-4o-mini": (0.15 / 1_000_000, 0.60 / 1_000_000),
    "gpt-4o": (2.50 / 1_000_000, 10.00 / 1_000_000),
    "gpt-4-turbo": (10.00 / 1_000_000, 30.00 / 1_000_000),
    "text-embedding-3-small": (0.02 / 1_000_000, 0.0),
    "text-embedding-3-large": (0.13 / 1_000_000, 0.0),
}


def _cost(model: str, in_tokens: int, out_tokens: int = 0) -> float:
    rates = PRICE_PER_TOKEN.get(model, (0.0, 0.0))
    return in_tokens * rates[0] + out_tokens * rates[1]


class ChatHistoryMessage(BaseModel):
    role: Literal["user", "assistant"]
    content: str


HISTORY_MAX_MESSAGES = 6


class ChatRequest(BaseModel):
    question: str = Field(..., min_length=1)
    k: int = Field(5, ge=1, le=20)
    history: list[ChatHistoryMessage] = Field(default_factory=list)


def _sse(event: str, data: object) -> str:
    return f"event: {event}\ndata: {json.dumps(data)}\n\n"


@router.post("/chat")
async def chat(
    body: ChatRequest,
    sb_user: Annotated[Client, Depends(supabase_user)],
    openai: Annotated[AsyncOpenAI, Depends(openai_client)],
):
    async def generate():
        t0 = time.perf_counter()

        def ms() -> int:
            return int((time.perf_counter() - t0) * 1000)

        # Resolve workspace once for the chat_logs write at the end.
        ws = (
            sb_user.table("workspaces")
            .select("id")
            .order("created_at", desc=False)
            .limit(1)
            .maybe_single()
            .execute()
        )
        workspace_id = ws.data["id"] if ws and ws.data else None

        # === Stage 1: embed the question ===
        t_embed_start = time.perf_counter()
        yield _sse("stage", {"label": "Encoding your question", "elapsed_ms": ms()})

        embed_usage: dict = {}
        q_vec = await embed_query(openai, body.question, usage_out=embed_usage)
        embed_ms = int((time.perf_counter() - t_embed_start) * 1000)

        # === Stage 2: graph-augmented vector search ===
        t_search_start = time.perf_counter()
        yield _sse(
            "stage",
            {"label": "Searching memory + 1-hop graph", "elapsed_ms": ms()},
        )
        raw_chunks = await search_chunks_with_neighbors(
            sb_user, q_vec, body.k, neighbor_count=1
        )
        chunks = [
            c
            for c in raw_chunks
            if (c.get("similarity") or 0.0) >= RELEVANCE_THRESHOLD
        ]
        search_ms = int((time.perf_counter() - t_search_start) * 1000)

        # === Surface filtered chunks as `sources` ===
        sources = [
            {
                "i": i + 1,
                "id": c["id"],
                "node_id": c["node_id"],
                "similarity": c.get("similarity"),
                "source": c.get("source", "direct"),
                "preview": (c["content"] or "")[:240],
            }
            for i, c in enumerate(chunks)
        ]
        yield _sse("sources", sources)

        # === Stage 3: prompt assembly + LLM stream ===
        plural = "s" if len(chunks) != 1 else ""
        if chunks:
            stage_label = f"Composing answer from {len(chunks)} chunk{plural}"
        elif raw_chunks:
            stage_label = "No strong matches — replying conversationally"
        else:
            stage_label = "Memory is empty — replying conversationally"
        yield _sse("stage", {"label": stage_label, "elapsed_ms": ms()})

        history = [
            {"role": m.role, "content": m.content}
            for m in body.history[-HISTORY_MAX_MESSAGES:]
        ]
        messages = build_chat_messages(body.question, chunks, history)

        # Emit the full prompt for the chat-panel debug view.
        yield _sse(
            "prompt",
            {
                "messages": messages,
                "model": settings.openai_chat_model,
                "temperature": 0.2,
            },
        )

        t_llm_start = time.perf_counter()
        llm_usage: dict = {}
        answer_parts: list[str] = []
        async for token in stream_chat_messages(openai, messages, usage_out=llm_usage):
            answer_parts.append(token)
            yield _sse("token", token)
        llm_ms = int((time.perf_counter() - t_llm_start) * 1000)
        total_ms = ms()

        answer = "".join(answer_parts)
        embed_tokens = embed_usage.get("tokens", 0)
        prompt_tokens = llm_usage.get("prompt_tokens", 0)
        completion_tokens = llm_usage.get("completion_tokens", 0)
        cost_usd = _cost(
            settings.openai_embedding_model, embed_tokens
        ) + _cost(
            settings.openai_chat_model, prompt_tokens, completion_tokens
        )

        # === Done event with totals ===
        yield _sse(
            "done",
            {
                "elapsed_ms": total_ms,
                "embed_tokens": embed_tokens,
                "prompt_tokens": prompt_tokens,
                "completion_tokens": completion_tokens,
                "cost_usd": round(cost_usd, 6),
            },
        )

        # === Persist chat log for observability ===
        if workspace_id:
            similarities = [c.get("similarity") for c in chunks if c.get("similarity") is not None]
            status = "success" if chunks else (
                "empty_context" if raw_chunks else "empty_context"
            )
            log_row = {
                "workspace_id": workspace_id,
                "question": body.question,
                "answer": answer,
                "prompt_messages": messages,
                "cited_node_ids": list({c["node_id"] for c in chunks}),
                "model": settings.openai_chat_model,
                "embed_model": settings.openai_embedding_model,
                "retrieval_strategy": "match_chunks_with_neighbors",
                "k_requested": body.k,
                "k_returned_raw": len(raw_chunks),
                "k_returned_filtered": len(chunks),
                "similarity_min": min(similarities) if similarities else None,
                "similarity_max": max(similarities) if similarities else None,
                "history_size": len(history),
                "embed_ms": embed_ms,
                "search_ms": search_ms,
                "llm_ms": llm_ms,
                "total_ms": total_ms,
                "embed_tokens": embed_tokens,
                "prompt_tokens": prompt_tokens,
                "completion_tokens": completion_tokens,
                "cost_usd": round(cost_usd, 6),
                "status": status,
            }
            try:
                sb_user.table("chat_logs").insert(log_row).execute()
            except Exception:
                # Logging must never break the user response.
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
