-- ============================================================================
-- chat_logs — observability table for the /chat endpoint.
--
-- One row per completed chat turn. Captures everything you'd want for
-- debugging, cost tracking, latency analysis, and retrieval quality:
--   - the question, the answer, the full prompt array sent to OpenAI
--   - the chunks that fed the prompt (cited_node_ids for citation analytics)
--   - per-stage timings (embed, search, LLM)
--   - token counts (embed, prompt, completion) and computed $ cost
--   - retrieval metadata (strategy, k, similarity range)
--
-- This is what backend observability platforms (Langfuse, Phoenix, Helicone)
-- store. Building it ourselves means we understand the shape before adopting
-- one. Migration to OpenTelemetry → external tool is straightforward later.
--
-- RLS workspace-scoped — users only see their own chat history.
-- ============================================================================

create table public.chat_logs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  created_at timestamptz default now(),

  -- Content
  question text not null,
  answer text,
  prompt_messages jsonb not null,  -- the array sent to OpenAI
  cited_node_ids uuid[],

  -- Pipeline metadata
  model text,
  embed_model text,
  retrieval_strategy text,         -- 'match_chunks' | 'match_chunks_with_neighbors'
  k_requested int,
  k_returned_raw int,
  k_returned_filtered int,
  similarity_min real,
  similarity_max real,
  history_size int default 0,

  -- Timings (ms)
  embed_ms int,
  search_ms int,
  llm_ms int,
  total_ms int,

  -- Token usage
  embed_tokens int default 0,
  prompt_tokens int default 0,
  completion_tokens int default 0,
  cost_usd numeric(10, 6) default 0,

  -- 'success' | 'empty_context' | 'failed'
  status text default 'success'
);

create index chat_logs_workspace_idx on public.chat_logs(workspace_id, created_at desc);

alter table public.chat_logs enable row level security;

create policy "own chat_logs" on public.chat_logs
  for all
  using (workspace_id in (select id from public.workspaces where owner_id = auth.uid()))
  with check (workspace_id in (select id from public.workspaces where owner_id = auth.uid()));
