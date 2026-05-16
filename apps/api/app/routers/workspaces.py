"""Workspace-level endpoints.

P1: `/workspaces/{id}/rebuild-edges` — runs the semantic-edges RPC.
P2: `/workspaces/{id}/recompute-clusters` — agentic topic clustering.

Why these live server-side instead of direct Supabase RPC calls from the
browser: keeping them here makes future P3 work (agent-driven rebuilds on
node create/update, scheduled sweeps, etc.) a drop-in change without
touching the frontend.
"""

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from openai import AsyncOpenAI
from pydantic import BaseModel
from supabase import Client

from ..config import settings
from ..deps import get_user_id, openai_client, supabase_user
from ..services.clustering import cluster_workspace

router = APIRouter()


class RebuildEdgesResponse(BaseModel):
    edges_created: int
    k_neighbors: int
    min_weight: float


@router.post(
    "/workspaces/{workspace_id}/rebuild-edges",
    response_model=RebuildEdgesResponse,
)
async def rebuild_semantic_edges(
    workspace_id: UUID,
    user_id: Annotated[str, Depends(get_user_id)],
    sb_user: Annotated[Client, Depends(supabase_user)],
    # Auto-connect v2.1 (migration 0006): best-pair-chunk + kNN per node +
    # minimum-weight floor.
    # K=3 → each node gets up to 3 of its most-similar partners.
    # min_weight=0.30 → drops weak edges even if they're top-K. Audit
    # surfaced spurious low-weight connections (e.g. agent-saved notes
    # linking to unrelated Summary nodes via shared keywords). Raised
    # from 0.25 → 0.30 after live observation: real semantic matches in
    # this corpus score >= 0.30 reliably; below that is structural
    # false-friends ("people doing things together" patterns, etc.).
    k_neighbors: int = 3,
    min_weight: float = 0.30,
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
            {
                "ws_id": str(workspace_id),
                "k_neighbors": k_neighbors,
                "min_weight": min_weight,
            },
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
        min_weight=min_weight,
    )


# ---------------------------------------------------------------------------
# Topic clustering — k-means on node-mean embeddings + LLM naming
# ---------------------------------------------------------------------------


# Same per-token rates table as routers/chat.py keeps cost math local.
_PRICE_PER_TOKEN: dict[str, tuple[float, float]] = {
    "gpt-4o-mini": (0.15 / 1_000_000, 0.60 / 1_000_000),
    "gpt-4o": (2.50 / 1_000_000, 10.00 / 1_000_000),
}


class RecomputeClustersResponse(BaseModel):
    clusters_created: int
    k_chosen: int | None
    silhouette: float | None
    naming_tokens_in: int
    naming_tokens_out: int
    naming_ms: int
    # naming_calls = LLM calls actually issued. The rest (naming_skipped) were
    # reused from the previous run's labels via members_hash match.
    naming_calls: int
    naming_skipped: int
    cost_usd: float


@router.post(
    "/workspaces/{workspace_id}/recompute-clusters",
    response_model=RecomputeClustersResponse,
)
async def recompute_clusters(
    workspace_id: UUID,
    user_id: Annotated[str, Depends(get_user_id)],
    sb_user: Annotated[Client, Depends(supabase_user)],
    openai: Annotated[AsyncOpenAI, Depends(openai_client)],
) -> RecomputeClustersResponse:
    """Agentic topic clustering: k-means on node-mean embeddings + LLM naming.

    Pipeline:
      1. Pull node-mean embeddings via the workspace_node_embeddings SQL fn.
      2. Pull titles for each node (for the LLM-naming step).
      3. Run k-means with silhouette-score K selection (services/clustering.py).
      4. For each cluster, ask gpt-4o-mini for a 2-3 word topic label.
      5. DELETE existing clusters for this workspace (cascade NULLs nodes.cluster_id).
      6. INSERT new cluster rows, then UPDATE nodes.cluster_id by member.

    Destructive on the workspace's clusters table by design — the previous
    cluster identities (and labels) become stale once the corpus shifts.
    """
    # --- Pull embeddings + titles in parallel ---
    try:
        emb_result = sb_user.rpc(
            "workspace_node_embeddings",
            {"ws_id": str(workspace_id)},
        ).execute()
    except Exception as e:
        raise HTTPException(
            status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"failed to fetch embeddings: {e}",
        ) from e

    rows = emb_result.data or []
    if not rows:
        return RecomputeClustersResponse(
            clusters_created=0,
            k_chosen=None,
            silhouette=None,
            naming_tokens_in=0,
            naming_tokens_out=0,
            naming_ms=0,
            cost_usd=0.0,
        )

    embeddings_by_node: dict[str, list[float]] = {}
    for row in rows:
        emb = row.get("embedding")
        # pgvector embeddings come back as a string like "[0.1, 0.2, ...]"
        # via PostgREST; parse to list[float].
        if isinstance(emb, str):
            try:
                emb = [float(x) for x in emb.strip("[]").split(",") if x.strip()]
            except ValueError:
                continue
        if isinstance(emb, list):
            embeddings_by_node[row["node_id"]] = emb

    titles_resp = (
        sb_user.table("nodes")
        .select("id,title")
        .eq("workspace_id", str(workspace_id))
        .execute()
    )
    titles_by_node = {
        r["id"]: (r.get("title") or "(untitled)") for r in (titles_resp.data or [])
    }

    # Pull the previous run's (members_hash → label) so we can reuse labels
    # for clusters whose membership didn't change. Saves ~$0.0001 × N
    # unchanged clusters per recompute, which dominates in steady state.
    prior_resp = (
        sb_user.table("clusters")
        .select("members_hash,label")
        .eq("workspace_id", str(workspace_id))
        .execute()
    )
    previous_label_by_hash = {
        r["members_hash"]: r["label"]
        for r in (prior_resp.data or [])
        if r.get("members_hash")
    }

    # --- Cluster + name ---
    result = await cluster_workspace(
        openai,
        embeddings_by_node,
        titles_by_node,
        previous_label_by_hash=previous_label_by_hash,
    )

    # --- Persist: replace this workspace's clusters atomically-enough ---
    # 1. Delete prior clusters for this workspace (nodes.cluster_id → NULL via FK).
    sb_user.table("clusters").delete().eq("workspace_id", str(workspace_id)).execute()

    # 2. Insert new cluster rows, capture returned ids.
    if not result.clusters:
        return _build_response(result, 0)

    insert_payload = [
        {
            "workspace_id": str(workspace_id),
            "label": c.label,
            "members_hash": c.members_hash,
        }
        for c in result.clusters
    ]
    inserted = (
        sb_user.table("clusters").insert(insert_payload).execute()
    )
    inserted_rows = inserted.data or []

    # 3. Update each node's cluster_id by member list.
    for cluster_row, cluster in zip(inserted_rows, result.clusters):
        if not cluster.member_ids:
            continue
        sb_user.table("nodes").update(
            {"cluster_id": cluster_row["id"]}
        ).in_("id", cluster.member_ids).execute()

    return _build_response(result, len(inserted_rows))


def _build_response(
    result, clusters_created: int
) -> RecomputeClustersResponse:
    rates = _PRICE_PER_TOKEN.get(settings.openai_chat_model, (0.0, 0.0))
    cost = (
        result.naming_tokens_in * rates[0]
        + result.naming_tokens_out * rates[1]
    )
    skipped = sum(1 for c in result.clusters if c.naming_skipped)
    return RecomputeClustersResponse(
        clusters_created=clusters_created,
        k_chosen=result.k_chosen,
        silhouette=result.silhouette,
        naming_tokens_in=result.naming_tokens_in,
        naming_tokens_out=result.naming_tokens_out,
        naming_ms=result.naming_ms,
        naming_calls=result.naming_calls,
        naming_skipped=skipped,
        cost_usd=round(cost, 6),
    )
