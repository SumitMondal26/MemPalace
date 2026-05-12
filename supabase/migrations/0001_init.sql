-- ============================================================================
-- Mem Palace — initial schema
--   - profiles / workspaces / nodes / edges / uploads / chunks
--   - pgvector for embeddings (vector(1536) = text-embedding-3-small)
--   - RLS on every table, workspace-scoped via auth.uid()
--   - trigger: auto-create profile + default workspace on signup
-- ============================================================================

-- Extensions -----------------------------------------------------------------
create extension if not exists vector;
create extension if not exists pgcrypto;

-- Tables ---------------------------------------------------------------------

create table profiles (
  id           uuid primary key references auth.users on delete cascade,
  display_name text,
  created_at   timestamptz default now()
);

create table workspaces (
  id         uuid primary key default gen_random_uuid(),
  owner_id   uuid not null references profiles(id) on delete cascade,
  name       text not null,
  created_at timestamptz default now()
);
create index workspaces_owner_idx on workspaces(owner_id);

create table nodes (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  type         text not null check (type in ('note','doc','image','url','cluster')),
  title        text,
  content      text,
  metadata     jsonb default '{}'::jsonb,
  x            double precision default 0,
  y            double precision default 0,
  created_at   timestamptz default now(),
  updated_at   timestamptz default now()
);
create index nodes_workspace_idx on nodes(workspace_id);

create table edges (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  source_id    uuid not null references nodes(id) on delete cascade,
  target_id    uuid not null references nodes(id) on delete cascade,
  kind         text not null check (kind in ('manual','semantic')),
  weight       real default 1.0,
  created_at   timestamptz default now(),
  -- Prevent duplicate edges of the same kind in the same direction.
  unique (source_id, target_id, kind)
);
create index edges_workspace_idx on edges(workspace_id);
create index edges_source_idx    on edges(source_id);
create index edges_target_idx    on edges(target_id);

create table uploads (
  id           uuid primary key default gen_random_uuid(),
  node_id      uuid not null references nodes(id) on delete cascade,
  storage_path text not null,
  mime_type    text,
  status       text default 'pending' check (status in ('pending','processed','failed')),
  created_at   timestamptz default now()
);
create index uploads_node_idx on uploads(node_id);

create table chunks (
  id          uuid primary key default gen_random_uuid(),
  node_id     uuid not null references nodes(id) on delete cascade,
  chunk_index int  not null,
  content     text not null,
  token_count int,
  embedding   vector(1536),
  created_at  timestamptz default now()
);
create index chunks_node_idx on chunks(node_id);

-- HNSW index for cosine similarity search.
-- Built lazily on first INSERT; safe to create empty.
create index chunks_embedding_idx on chunks
  using hnsw (embedding vector_cosine_ops);

-- updated_at trigger for nodes ----------------------------------------------
create function set_updated_at() returns trigger as $$
begin
  new.updated_at = now();
  return new;
end $$ language plpgsql;

create trigger nodes_updated_at
  before update on nodes
  for each row execute function set_updated_at();

-- Row-Level Security ---------------------------------------------------------
-- Pattern: every table is reachable only through a workspace the caller owns.
-- auth.uid() resolves to the caller's user id from the JWT.

alter table profiles   enable row level security;
alter table workspaces enable row level security;
alter table nodes      enable row level security;
alter table edges      enable row level security;
alter table uploads    enable row level security;
alter table chunks     enable row level security;

create policy "own profile" on profiles
  for all
  using (id = auth.uid())
  with check (id = auth.uid());

create policy "own workspaces" on workspaces
  for all
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid());

create policy "own nodes" on nodes
  for all
  using (workspace_id in (select id from workspaces where owner_id = auth.uid()))
  with check (workspace_id in (select id from workspaces where owner_id = auth.uid()));

create policy "own edges" on edges
  for all
  using (workspace_id in (select id from workspaces where owner_id = auth.uid()))
  with check (workspace_id in (select id from workspaces where owner_id = auth.uid()));

create policy "own uploads" on uploads
  for all
  using (node_id in (
    select n.id from nodes n
    join workspaces w on n.workspace_id = w.id
    where w.owner_id = auth.uid()
  ))
  with check (node_id in (
    select n.id from nodes n
    join workspaces w on n.workspace_id = w.id
    where w.owner_id = auth.uid()
  ));

create policy "own chunks" on chunks
  for all
  using (node_id in (
    select n.id from nodes n
    join workspaces w on n.workspace_id = w.id
    where w.owner_id = auth.uid()
  ))
  with check (node_id in (
    select n.id from nodes n
    join workspaces w on n.workspace_id = w.id
    where w.owner_id = auth.uid()
  ));

-- New-user trigger -----------------------------------------------------------
-- When auth.users gains a row (signup), create a profile and a default
-- workspace. SECURITY DEFINER so it can write across RLS boundaries.
--
-- IMPORTANT: SECURITY DEFINER functions must pin `search_path` and use
-- schema-qualified table names. Supabase hardens SECURITY DEFINER defaults
-- so an unqualified table reference will fail to resolve. This also closes
-- a search-path injection vector (CVE-class).

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, display_name) values (new.id, new.email);
  insert into public.workspaces (owner_id, name) values (new.id, 'My Memory Palace');
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Search helper RPC ----------------------------------------------------------
-- Convenience function for vector search. Called from FastAPI.
-- Returns the top-k chunks (cosine distance) within the caller's workspaces.
-- RLS still applies because we don't mark it SECURITY DEFINER.

create function match_chunks(
  query_embedding vector(1536),
  match_count     int default 5
) returns table (
  id          uuid,
  node_id     uuid,
  content     text,
  similarity  float
) language sql stable as $$
  select
    c.id,
    c.node_id,
    c.content,
    1 - (c.embedding <=> query_embedding) as similarity
  from chunks c
  where c.embedding is not null
  order by c.embedding <=> query_embedding
  limit match_count;
$$;
