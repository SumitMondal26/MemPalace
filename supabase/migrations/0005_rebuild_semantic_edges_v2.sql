-- ============================================================================
-- Auto-connect v2: best-pair-chunk + kNN per node
--
-- Replaces the threshold-based logic from 0003 with two architectural shifts:
--
-- 1. Best-pair-chunk similarity:
--    Instead of comparing two nodes via mean(chunks_A) vs mean(chunks_B),
--    we compute pairwise cosine over EVERY chunk-of-A × chunk-of-B and take
--    the max. This solves the "long-doc dilution" problem — a 23-chunk paper's
--    mean lives in generic-topic space and matches nothing specifically, but
--    one of its 23 chunks usually matches a related note strongly.
--
-- 2. kNN per node (no absolute threshold):
--    For each node, take top-K most-similar partners and link them.
--    A single global threshold can't serve all node-pair scales (short notes
--    peak ~0.6, long-doc-mean pairs peak ~0.4). Relative ranking adapts to
--    each node's local neighborhood.
--    "Either-direction" inclusion: A↔B forms if B is in A's top-K OR A is in
--    B's top-K. More inclusive than mutual-kNN — every node gets ~K edges.
--
-- Result: every node always has ~K visible connections, regardless of corpus
-- composition. Long docs become first-class graph citizens. No threshold to
-- tune. Edge `weight` carries the strength signal so the canvas can fade weak
-- edges visually.
--
-- Backward compat: function name unchanged.
--
-- Drop the old (uuid, real) signature from migration 0003 explicitly. Without
-- this, both signatures coexist via Postgres function overloading and any
-- pg_proc lookup by name fails with "more than one function named".
-- ============================================================================

drop function if exists public.rebuild_semantic_edges(uuid, real);
drop function if exists public.rebuild_semantic_edges(uuid, int, real);

create or replace function public.rebuild_semantic_edges(
  ws_id uuid,
  k_neighbors int default 3
)
returns int
language plpgsql
as $$
declare
  inserted_count int := 0;
begin
  -- Clear existing semantic edges (manual edges untouched).
  delete from public.edges
  where workspace_id = ws_id and kind = 'semantic';

  with
  -- Step 1: best-pair-chunk score for every (smaller_id, larger_id) pair
  -- of nodes in the workspace. We constrain ca.node_id < cb.node_id so each
  -- pair is computed once.
  pair_max as (
    select
      ca.node_id as a_id,
      cb.node_id as b_id,
      max(1 - (ca.embedding <=> cb.embedding)) as similarity
    from public.chunks ca
    join public.nodes na on na.id = ca.node_id
    join public.chunks cb on cb.embedding is not null
    join public.nodes nb on nb.id = cb.node_id
    where na.workspace_id = ws_id
      and nb.workspace_id = ws_id
      and ca.node_id < cb.node_id
      and ca.embedding is not null
    group by ca.node_id, cb.node_id
  ),
  -- Step 2: split each undirected pair into two directed views so kNN ranking
  -- can run from each node's perspective.
  bidirectional as (
    select a_id as node_id, b_id as partner_id, similarity from pair_max
    union all
    select b_id as node_id, a_id as partner_id, similarity from pair_max
  ),
  -- Step 3: kNN per node — for each node, rank its potential partners by
  -- best-pair-chunk similarity and keep the top-K.
  ranked as (
    select node_id, partner_id, similarity,
           row_number() over (
             partition by node_id
             order by similarity desc
           ) as rn
    from bidirectional
  ),
  selected as (
    select node_id, partner_id, similarity
    from ranked
    where rn <= k_neighbors
  ),
  -- Step 4: collapse back to undirected pairs (smaller, larger). An edge
  -- appears if it was selected from either direction (either-kNN).
  unique_edges as (
    select
      least(node_id, partner_id) as src,
      greatest(node_id, partner_id) as tgt,
      max(similarity) as sim
    from selected
    group by least(node_id, partner_id), greatest(node_id, partner_id)
  )
  insert into public.edges (workspace_id, source_id, target_id, kind, weight)
  select ws_id, src, tgt, 'semantic', sim
  from unique_edges;

  get diagnostics inserted_count = row_count;
  return inserted_count;
end;
$$;
