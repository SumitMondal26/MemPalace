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
from ..services.retrieval import embed_query, search_chunks

router = APIRouter()


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

        # Stage 2: vector search.
        yield _sse(
            "stage",
            {"label": "Searching memory", "elapsed_ms": ms()},
        )
        chunks = await search_chunks(sb_user, q_vec, body.k)

        # Surface the retrieved chunks so the UI can show citations early.
        sources = [
            {
                "i": i + 1,
                "id": c["id"],
                "node_id": c["node_id"],
                "similarity": c.get("similarity"),
                "preview": (c["content"] or "")[:240],
            }
            for i, c in enumerate(chunks)
        ]
        yield _sse("sources", sources)

        # Stage 3: prompt assembly + LLM stream.
        plural = "s" if len(chunks) != 1 else ""
        yield _sse(
            "stage",
            {
                "label": (
                    f"Composing answer from {len(chunks)} chunk{plural}"
                    if chunks
                    else "Composing answer (no context found)"
                ),
                "elapsed_ms": ms(),
            },
        )

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
