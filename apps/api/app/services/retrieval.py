"""Top-k semantic retrieval over the chunks table.

Split into two stages so the chat router can emit a `stage` SSE event between
them and report real timings:

    embed_query   → 1 OpenAI embeddings call, returns a single 1536-vec.
    search_chunks → pgvector RPC, returns the k closest chunks.

Both run under the caller's JWT (supabase_user client), so RLS scopes the
search to the caller's chunks automatically.
"""

from openai import AsyncOpenAI
from supabase import Client

from ..config import settings


async def embed_query(
    openai: AsyncOpenAI,
    query: str,
    usage_out: dict | None = None,
) -> list[float]:
    """Embed a query. If usage_out is provided, mutate with token count."""
    if not query.strip():
        return []
    resp = await openai.embeddings.create(
        model=settings.openai_embedding_model,
        input=[query],
    )
    if usage_out is not None and resp.usage:
        usage_out["tokens"] = resp.usage.total_tokens
    return resp.data[0].embedding


async def search_chunks(
    sb_user: Client,
    query_embedding: list[float],
    k: int = 5,
) -> list[dict]:
    if not query_embedding:
        return []
    result = sb_user.rpc(
        "match_chunks",
        {"query_embedding": query_embedding, "match_count": k},
    ).execute()
    return result.data or []


async def search_chunks_with_neighbors(
    sb_user: Client,
    query_embedding: list[float],
    k: int = 5,
    neighbor_count: int = 1,
) -> list[dict]:
    """Graph-augmented retrieval: top-k by vector + 1-hop graph expansion.

    Returns chunks with an extra `source` field: "direct" (came from vector
    similarity) or "neighbor" (pulled in via an edge from a direct hit's node).
    """
    if not query_embedding:
        return []
    result = sb_user.rpc(
        "match_chunks_with_neighbors",
        {
            "query_embedding": query_embedding,
            "match_count": k,
            "neighbor_count": neighbor_count,
        },
    ).execute()
    return result.data or []


async def retrieve(
    sb_user: Client,
    openai: AsyncOpenAI,
    query: str,
    k: int = 5,
) -> list[dict]:
    """Convenience: embed + search in one call. Used outside chat (no tracing)."""
    q_vec = await embed_query(openai, query)
    return await search_chunks(sb_user, q_vec, k)
