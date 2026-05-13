-- ============================================================================
-- Graph-augmented retrieval (1-hop neighborhood expansion).
--
-- Step 1: vector search → top-k "seed" chunks (same as match_chunks).
-- Step 2: walk edges (manual + semantic, undirected) → find nodes 1 hop from
--         any seed node, EXCLUDING nodes already in the seed set.
-- Step 3: for each neighbor node, take its top-N most-relevant chunks for
--         this query (window function partitioned by node_id).
-- Step 4: union seeds + neighbor chunks, ordered by source (direct first)
--         then by similarity.
--
-- Returns a `source` column so the caller can distinguish chunks that came
-- from direct vector match vs graph expansion. The LLM doesn't need to know
-- the difference; the trace UI eventually will.
--
-- RLS: function is STABLE (not SECURITY DEFINER), so RLS on chunks/edges
-- applies — caller only sees their own workspace's content.
-- ============================================================================

create or replace function public.match_chunks_with_neighbors(
  query_embedding vector(1536),
  match_count int default 5,
  neighbor_count int default 1
)
returns table (
  id uuid,
  node_id uuid,
  content text,
  similarity float,
  source text
)
language sql
stable
as $$
  with seed as (
    select c.id,
           c.node_id,
           c.content,
           1 - (c.embedding <=> query_embedding) as similarity
    from public.chunks c
    where c.embedding is not null
    order by c.embedding <=> query_embedding
    limit match_count
  ),
  seed_nodes as (
    select distinct node_id from seed
  ),
  neighbor_nodes as (
    -- Treat edges as undirected: a neighbor is whichever end isn't a seed.
    select distinct
      case
        when e.source_id = sn.node_id then e.target_id
        else e.source_id
      end as node_id
    from public.edges e
    join seed_nodes sn
      on (e.source_id = sn.node_id or e.target_id = sn.node_id)
    where
      case
        when e.source_id = sn.node_id then e.target_id
        else e.source_id
      end not in (select node_id from seed_nodes)
  ),
  neighbor_ranked as (
    select c.id,
           c.node_id,
           c.content,
           1 - (c.embedding <=> query_embedding) as similarity,
           row_number() over (
             partition by c.node_id
             order by c.embedding <=> query_embedding
           ) as rn
    from public.chunks c
    join neighbor_nodes nn on nn.node_id = c.node_id
    where c.embedding is not null
  ),
  combined as (
    select id, node_id, content, similarity, 0 as src_rank, 'direct'::text as source
    from seed
    union all
    select id, node_id, content, similarity, 1 as src_rank, 'neighbor'::text as source
    from neighbor_ranked
    where rn <= neighbor_count
  )
  select id, node_id, content, similarity, source
  from combined
  order by src_rank asc, similarity desc;
$$;
