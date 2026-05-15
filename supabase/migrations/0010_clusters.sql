-- ============================================================================
-- Clusters — workspace-scoped topic groupings produced by the agentic
-- clustering service (k-means on node-mean embeddings + LLM-named labels).
--
-- Why a dedicated table (not a metadata jsonb stuff-it-in approach):
--   - We want to render a cluster legend without scanning every node.
--   - We want "all nodes in cluster X" via a normal join, not a jsonb scan.
--   - Cluster identity (label, color hint) is workspace-scoped and rebuilt
--     periodically — its lifecycle is different from a node's metadata.
--
-- Why nodes.cluster_id is nullable:
--   - Brand-new nodes haven't been clustered yet.
--   - Workspaces that never ran "Recompute topics" have no clusters at all.
--   - On delete of a cluster we set the node's cluster_id back to NULL
--     (rather than cascade-delete the node).
--
-- Recompute is destructive: each run truncates this workspace's clusters
-- and re-creates them with fresh ids. UI must re-fetch after recompute.
-- ============================================================================

create table public.clusters (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  label text not null,
  -- Color hint is optional — frontend has its own palette and assigns
  -- deterministically from cluster id. Stored if the API ever wants to
  -- pre-pick (e.g. for shareable links).
  color text,
  created_at timestamptz default now()
);

create index clusters_workspace_idx on public.clusters(workspace_id);

alter table public.nodes
  add column if not exists cluster_id uuid references public.clusters(id) on delete set null;

create index if not exists nodes_cluster_idx on public.nodes(cluster_id);

-- RLS — same pattern as the rest of the schema: workspace-scoped via owner.
alter table public.clusters enable row level security;

create policy "own clusters" on public.clusters
  for all
  using (workspace_id in (select id from public.workspaces where owner_id = auth.uid()))
  with check (workspace_id in (select id from public.workspaces where owner_id = auth.uid()));

-- Helper: returns (node_id, embedding) for every node in a workspace that
-- has at least one chunk. Used by the clustering service to fetch
-- node-mean embeddings in a single round-trip.
--
-- The AVG over pgvector returns a vector of the same dimension because
-- pgvector defines vector_avg as the elementwise mean. Cast to vector(1536)
-- so the receiving client gets a typed result.
create or replace function public.workspace_node_embeddings(ws_id uuid)
returns table (node_id uuid, embedding vector(1536))
language sql
stable
as $$
  select c.node_id, avg(c.embedding)::vector(1536) as embedding
  from public.chunks c
  join public.nodes n on n.id = c.node_id
  where n.workspace_id = ws_id
  group by c.node_id;
$$;
