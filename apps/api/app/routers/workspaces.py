"""Workspace-level endpoints.

P1: `/workspaces/{id}/rebuild-edges` — runs the semantic-edges RPC.

Why this lives server-side instead of as a direct Supabase RPC call from the
browser: keeping it here makes the future P3 work (agent-driven rebuilds on
node create/update, scheduled sweeps, etc.) a drop-in change without touching
the frontend.
"""

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from supabase import Client

from ..deps import get_user_id, supabase_user

router = APIRouter()


class RebuildEdgesResponse(BaseModel):
    edges_created: int
    threshold: float


@router.post(
    "/workspaces/{workspace_id}/rebuild-edges",
    response_model=RebuildEdgesResponse,
)
async def rebuild_semantic_edges(
    workspace_id: UUID,
    user_id: Annotated[str, Depends(get_user_id)],
    sb_user: Annotated[Client, Depends(supabase_user)],
    # Empirical default for OpenAI text-embedding-3-small over node-mean
    # embeddings on short notes. Iteration history:
    #   0.65 → 0 edges (theoretical guess, too strict for short text)
    #   0.50 → caught only the very strongest pair (sumit ↔ sumit's age @ 0.617)
    #   0.40 → catches related entities like Eijuuu (sumit's gf) ↔ sumit @ 0.427,
    #          at the cost of 1-2 surface-form false friends per N nodes.
    # For short notes this is the realistic ceiling without an LLM-rerank pass.
    # Long-doc workspaces could go higher (~0.55) once P2 best-pair-chunk lands.
    sim_threshold: float = 0.4,
) -> RebuildEdgesResponse:
    """Rebuild the workspace's semantic edges based on node-embedding similarity.

    Calls the `rebuild_semantic_edges` SQL function defined in
    `supabase/migrations/0003_rebuild_semantic_edges.sql`. The function:
      1. Verifies workspace ownership via RLS on DELETE/INSERT.
      2. Removes existing kind='semantic' edges.
      3. Computes mean(chunk.embedding) per node.
      4. Inserts an edge for every node pair with cosine similarity >= threshold.

    Manual edges (kind='manual') are untouched.
    """
    try:
        result = sb_user.rpc(
            "rebuild_semantic_edges",
            {"ws_id": str(workspace_id), "sim_threshold": sim_threshold},
        ).execute()
    except Exception as e:
        raise HTTPException(
            status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"rebuild failed: {e}",
        ) from e

    edges_created = result.data if isinstance(result.data, int) else 0
    return RebuildEdgesResponse(
        edges_created=edges_created,
        threshold=sim_threshold,
    )
