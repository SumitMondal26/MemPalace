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
    k_neighbors: int


@router.post(
    "/workspaces/{workspace_id}/rebuild-edges",
    response_model=RebuildEdgesResponse,
)
async def rebuild_semantic_edges(
    workspace_id: UUID,
    user_id: Annotated[str, Depends(get_user_id)],
    sb_user: Annotated[Client, Depends(supabase_user)],
    # Auto-connect v2 (migration 0005): best-pair-chunk similarity + kNN per
    # node. No more threshold tuning. K=3 → each node gets ~3 of its most-
    # similar partners as edges. Either-direction inclusion: A↔B forms if B
    # is in A's top-K OR A is in B's top-K.
    k_neighbors: int = 3,
) -> RebuildEdgesResponse:
    """Rebuild the workspace's semantic edges via best-pair-chunk + kNN.

    Calls the `rebuild_semantic_edges` SQL function defined in
    `supabase/migrations/0005_rebuild_semantic_edges_v2.sql`. The function:
      1. Computes max(cosine(chunk_a, chunk_b)) for every node pair.
      2. For each node, ranks all other nodes by that similarity.
      3. Inserts an edge if a node is in either party's top-K neighbors.
      4. Manual edges (kind='manual') are untouched.

    RLS on edges/chunks/nodes applies (function is STABLE, runs as caller).
    """
    try:
        result = sb_user.rpc(
            "rebuild_semantic_edges",
            {"ws_id": str(workspace_id), "k_neighbors": k_neighbors},
        ).execute()
    except Exception as e:
        raise HTTPException(
            status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"rebuild failed: {e}",
        ) from e

    edges_created = result.data if isinstance(result.data, int) else 0
    return RebuildEdgesResponse(
        edges_created=edges_created,
        k_neighbors=k_neighbors,
    )
