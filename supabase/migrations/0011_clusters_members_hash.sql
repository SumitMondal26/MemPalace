-- ============================================================================
-- clusters.members_hash — fingerprint of a cluster's membership.
--
-- Why: in steady state, most clusters between two recompute runs have
-- IDENTICAL membership. Re-asking the LLM to name a cluster whose members
-- haven't changed is wasted cost (~$0.0001 × N clusters) and wasted
-- latency.
--
-- Hash is the SHA-256 of the sorted member node ids, joined by NUL.
-- Any membership change → different hash → cluster gets re-named.
-- Identical membership → reuse the previous label.
--
-- Stored as text (hex) rather than bytea for easier debugging in psql.
-- Indexed because the recompute path looks up "is there an old cluster
-- with this hash in this workspace?" once per new cluster.
-- ============================================================================

alter table public.clusters
  add column if not exists members_hash text;

create index if not exists clusters_workspace_hash_idx
  on public.clusters(workspace_id, members_hash);
