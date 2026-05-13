-- ============================================================================
-- Auto-connect v2.1: kNN per node + minimum-weight floor.
--
-- Refinement to migration 0005. Adds `min_weight` parameter that drops edges
-- below an absolute similarity floor AFTER kNN ranking.
--
-- Why: kNN guarantees every node gets K partners, but it doesn't enforce
-- minimum quality. A node forced to fill K slots will pick weak matches if
-- nothing better exists. Those weak edges are noise — embedding similarity
-- can still pick up surface-form patterns ("people doing things together")
-- that look meaningful but aren't.
--
-- The floor is data-driven from observation: real semantic matches in our
-- corpus score 0.30+; below 0.25 are structural false-friends. A node that
-- has <K partners above floor will get fewer edges than K. That's the
-- correct outcome — better to be visually isolated than connected to noise.
--
-- Drop the previous (uuid, int) signature so there's no overload collision.
-- ============================================================================

drop function if exists public.rebuild_semantic_edges(uuid, int);

create or replace function public.rebuild_semantic_edges(
  ws_id uuid,
  k_neighbors int default 3,
  min_weight real default 0.25
)
returns int
language plpgsql
as $$
declare
  inserted_count int := 0;
begin
  delete from public.edges
  where workspace_id = ws_id and kind = 'semantic';

  with
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
  bidirectional as (
    select a_id as node_id, b_id as partner_id, similarity from pair_max
    union all
    select b_id as node_id, a_id as partner_id, similarity from pair_max
  ),
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
      and similarity >= min_weight  -- drop weak edges even if they're top-K
  ),
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
