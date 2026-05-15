"""POST /nodes/{node_id}/embed — make a node's content RAG-searchable.

Why we need this: /ingest handles uploaded files (PDFs etc.) and produces
chunks in the `chunks` table. But user-typed content lives in `nodes.content`
and never reached the embedder. This endpoint closes that gap.

Flow:
  1. AUTHORIZE via user JWT (RLS rejects if caller doesn't own the node).
  2. Read the current node.content.
  3. Replace the node's chunk set:
        DELETE FROM chunks WHERE node_id = ?
        INSERT chunked + embedded content (or skip if content is empty)
  4. Return counts.

Idempotent: calling repeatedly on the same content produces the same result.
Calling on empty content cleans up old chunks (so the node disappears from
retrieval results — exactly what you want when a note is cleared).

Race window (acceptable for P1): two rapid /embed calls for the same node
can interleave delete/insert and produce duplicate chunks. Fixes in P2 when
this moves behind a Redis queue with single-writer semantics per node.
"""

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from openai import AsyncOpenAI
from supabase import Client

from ..deps import get_user_id, openai_client, supabase_admin, supabase_user
from ..schemas import IngestResponse
from ..services.chunking import chunk_text, prepare_for_embedding
from ..services.embeddings import embed_batch

router = APIRouter()


@router.post("/nodes/{node_id}/embed", response_model=IngestResponse)
async def embed_node(
    node_id: UUID,
    user_id: Annotated[str, Depends(get_user_id)],
    sb_user: Annotated[Client, Depends(supabase_user)],
    sb_admin: Annotated[Client, Depends(supabase_admin)],
    openai: Annotated[AsyncOpenAI, Depends(openai_client)],
) -> IngestResponse:
    # AUTHORIZE: RLS will return no row if the user doesn't own this node.
    node_resp = (
        sb_user.table("nodes")
        .select("id, content")
        .eq("id", str(node_id))
        .maybe_single()
        .execute()
    )
    if not node_resp.data:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND,
            detail="node not found (or not yours)",
        )

    content = (node_resp.data.get("content") or "").strip()

    # Always wipe existing chunks first so the embedding set never drifts
    # from the node's current content state. Including the case where
    # content was just cleared — those chunks should disappear.
    sb_admin.table("chunks").delete().eq("node_id", str(node_id)).execute()

    if not content:
        return IngestResponse(chunks_created=0, total_tokens=0)

    # Strip URLs etc. before chunking — see services/chunking.prepare_for_embedding.
    # Keeps `nodes.content` intact (used for display + the URL preview in the
    # sidebar) but feeds the embedder only the prose carrying real signal.
    cleaned = prepare_for_embedding(content)
    if not cleaned:
        return IngestResponse(chunks_created=0, total_tokens=0)

    chunks = chunk_text(cleaned)
    if not chunks:
        return IngestResponse(chunks_created=0, total_tokens=0)

    embeddings = await embed_batch(openai, [c.content for c in chunks])

    rows = [
        {
            "node_id": str(node_id),
            "chunk_index": i,
            "content": c.content,
            "token_count": c.token_count,
            "embedding": emb,
        }
        for i, (c, emb) in enumerate(zip(chunks, embeddings, strict=True))
    ]
    sb_admin.table("chunks").insert(rows).execute()

    return IngestResponse(
        chunks_created=len(rows),
        total_tokens=sum(c.token_count for c in chunks),
    )
