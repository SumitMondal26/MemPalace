-- ============================================================================
-- Semantic edges via pairwise node-embedding cosine similarity.
--
-- A node's "embedding" is the mean of its chunk embeddings (pgvector's AVG
-- aggregate, 0.7+). For every pair of nodes in a workspace whose mean
-- embeddings have cosine similarity >= threshold, an edge with kind='semantic'
-- is inserted.
--
-- Idempotent: drops all existing kind='semantic' edges for the workspace
-- before inserting fresh ones. Manual edges (kind='manual') are untouched.
--
-- RLS: function runs as caller (no SECURITY DEFINER). The DELETE and INSERT
-- are gated by the workspace_id RLS policy on the edges table, which
-- enforces that the caller owns the workspace.
-- ============================================================================

create or replace function public.rebuild_semantic_edges(
  ws_id uuid,
  sim_threshold real default 0.5
)
returns int
language plpgsql
as $$
declare
  inserted_count int := 0;
begin
  -- Clear existing semantic edges (RLS will reject if caller doesn't own ws).
  delete from public.edges
  where workspace_id = ws_id and kind = 'semantic';

  -- Compute mean embedding per node, then pairwise cosine similarity,
  -- insert any pair above threshold. a.id < b.id avoids self-pairs and
  -- duplicate directions (we treat semantic edges as undirected).
  with node_emb as (
    select n.id, avg(c.embedding)::vector(1536) as embedding
    from public.nodes n
    join public.chunks c on c.node_id = n.id
    where n.workspace_id = ws_id
    group by n.id
  ),
  pairs as (
    select
      a.id as src,
      b.id as tgt,
      1 - (a.embedding <=> b.embedding) as sim
    from node_emb a
    cross join node_emb b
    where a.id < b.id
  )
  insert into public.edges (workspace_id, source_id, target_id, kind, weight)
  select ws_id, src, tgt, 'semantic', sim
  from pairs
  where sim >= sim_threshold;

  get diagnostics inserted_count = row_count;
  return inserted_count;
end;
$$;
