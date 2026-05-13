"""POST /chat — retrieval-augmented chat, streamed over SSE.

SSE event types:

    event: stage     data: { "label": "...", "elapsed_ms": int }
        Emitted at the start of each pipeline stage. UI renders these
        as a live trace so the user (and you, debugging) can see exactly
        what's happening at every step.

    event: sources   data: [{ "i", "id", "node_id", "similarity", "preview" }, ...]
        The retrieved chunks. Sent before tokens.

    event: token     data: "..."
        One delta from the LLM stream. Many of these.

    event: done      data: { "elapsed_ms": int }
        Final event. The total wall time is included so the UI can
        replace the spinner with a total-duration chip.

Today the pipeline is pure RAG (embed → search → compose). The same SSE
channel will carry richer events in P3 (tool_call, tool_result, reasoning,
reflection) — the UI's trace component just renders more rows.
"""

import json
import time
from typing import Annotated

from fastapi import APIRouter, Depends
from fastapi.responses import StreamingResponse
from openai import AsyncOpenAI
from pydantic import BaseModel, Field
from supabase import Client

from ..deps import openai_client, supabase_user
from ..services.llm import stream_chat
from ..services.retrieval import embed_query, search_chunks_with_neighbors

router = APIRouter()

# Cosine similarity threshold below which a retrieved chunk is considered
# noise. The match_chunks RPC returns top-k strictly by ranking, even when
# the query has no relevant matches at all (e.g. "hello" against technical
# content). Below ~0.4 the chunk is more likely to pollute the prompt with
# irrelevant context than to help — we'd rather show the model nothing
# and have it respond conversationally.
RELEVANCE_THRESHOLD = 0.4


class ChatRequest(BaseModel):
    question: str = Field(..., min_length=1)
    k: int = Field(5, ge=1, le=20)


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

        # Stage 1: embed the question.
        yield _sse(
            "stage",
            {"label": "Encoding your question", "elapsed_ms": ms()},
        )
        q_vec = await embed_query(openai, body.question)

        # Stage 2: graph-augmented vector search.
        yield _sse(
            "stage",
            {"label": "Searching memory + 1-hop graph", "elapsed_ms": ms()},
        )
        raw_chunks = await search_chunks_with_neighbors(
            sb_user, q_vec, body.k, neighbor_count=1
        )

        # Filter out low-similarity matches — they're noise. The match_chunks
        # RPC returns top-k by ranking even if every match is bad (e.g. asking
        # "hello" against a corpus of technical content); passing those to the
        # LLM produces "I don't have that in your memory yet" when the right
        # behavior is to chat conversationally. Apply the same threshold to
        # neighbor chunks so a weak graph hit doesn't pollute the prompt.
        chunks = [
            c
            for c in raw_chunks
            if (c.get("similarity") or 0.0) >= RELEVANCE_THRESHOLD
        ]

        # Surface the chunks that made the cut so the UI cites only the ones
        # the model actually saw. The `source` field tags each chunk as
        # "direct" (vector hit) or "neighbor" (graph expansion).
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

        # Stage 3: prompt assembly + LLM stream.
        plural = "s" if len(chunks) != 1 else ""
        if chunks:
            stage_label = f"Composing answer from {len(chunks)} chunk{plural}"
        elif raw_chunks:
            stage_label = "No strong matches — replying conversationally"
        else:
            stage_label = "Memory is empty — replying conversationally"
        yield _sse("stage", {"label": stage_label, "elapsed_ms": ms()})

        async for token in stream_chat(openai, body.question, chunks):
            yield _sse("token", token)

        yield _sse("done", {"elapsed_ms": ms()})

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )
