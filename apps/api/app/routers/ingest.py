"""POST /ingest — file → chunks → embeddings → DB.

Two-key auth pattern in this handler:
  - Authentication via JWT (get_user_id) — knows who is calling.
  - Authorization via the user-context Supabase client — RLS rejects if the
    caller doesn't own the node.
  - Once authorized, the actual work (storage download, chunks insert) uses
    the admin (service-role) client, which bypasses RLS for performance and
    bulk operations.

Re-ingestion replaces chunks for the target node. We delete then insert so
the embedding set never drifts from the source file.
"""

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status
from openai import AsyncOpenAI
from supabase import Client

from ..deps import get_user_id, openai_client, supabase_admin, supabase_user
from ..schemas import IngestRequest, IngestResponse
from ..services.chunking import chunk_text
from ..services.embeddings import embed_batch
from ..services.extract import extract_text

router = APIRouter()


@router.post("/ingest", response_model=IngestResponse)
async def ingest(
    body: IngestRequest,
    user_id: Annotated[str, Depends(get_user_id)],
    sb_user: Annotated[Client, Depends(supabase_user)],
    sb_admin: Annotated[Client, Depends(supabase_admin)],
    openai: Annotated[AsyncOpenAI, Depends(openai_client)],
) -> IngestResponse:
    # 1. AUTHORIZE: RLS will return no row if the user doesn't own the node.
    node_resp = (
        sb_user.table("nodes")
        .select("id, workspace_id")
        .eq("id", str(body.node_id))
        .maybe_single()
        .execute()
    )
    if not node_resp.data:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND,
            detail="node not found (or not yours)",
        )

    # 2. Record the upload (status='pending') for traceability.
    upload_row = (
        sb_admin.table("uploads")
        .insert(
            {
                "node_id": str(body.node_id),
                "storage_path": body.storage_path,
                "mime_type": body.mime_type,
                "status": "pending",
            }
        )
        .execute()
    )
    upload_id = upload_row.data[0]["id"]

    try:
        # 3. Download from Storage (service role).
        file_bytes = sb_admin.storage.from_("uploads").download(body.storage_path)

        # 4. Extract → chunk → embed.
        text = extract_text(file_bytes, body.mime_type)
        chunks = chunk_text(text)
        if not chunks:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="no extractable text (empty file or scanned PDF without OCR)",
            )

        embeddings = await embed_batch(openai, [c.content for c in chunks])

        # 5. Replace chunks for this node (atomic-ish — delete then insert).
        sb_admin.table("chunks").delete().eq("node_id", str(body.node_id)).execute()
        rows = [
            {
                "node_id": str(body.node_id),
                "chunk_index": i,
                "content": c.content,
                "token_count": c.token_count,
                "embedding": emb,
            }
            for i, (c, emb) in enumerate(zip(chunks, embeddings, strict=True))
        ]
        sb_admin.table("chunks").insert(rows).execute()

        # 6. Mark the upload processed.
        sb_admin.table("uploads").update({"status": "processed"}).eq(
            "id", upload_id
        ).execute()

        return IngestResponse(
            chunks_created=len(rows),
            total_tokens=sum(c.token_count for c in chunks),
        )

    except HTTPException:
        sb_admin.table("uploads").update({"status": "failed"}).eq(
            "id", upload_id
        ).execute()
        raise
    except Exception as e:
        sb_admin.table("uploads").update({"status": "failed"}).eq(
            "id", upload_id
        ).execute()
        raise HTTPException(
            status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"ingest failed: {e}",
        ) from e
