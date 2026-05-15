-- ============================================================================
-- chat_logs additions for the agent path (P3.1).
--
-- The /agent endpoint runs an LLM-tools loop: each iteration the model
-- decides to either call tools or return the final answer. We capture
-- every tool call + the iteration count for the same observability story
-- as /chat — debuggability, cost analysis, retrieval quality.
--
-- `tool_calls` shape:
--   [
--     { "iter": 0, "name": "search_memory", "args": {...},
--       "result_preview": "...", "ms": 234, "ok": true },
--     ...
--   ]
-- Stored as jsonb so /insights can scan + render without joining a
-- separate table. Per-call rows would normalize cleaner but the
-- list-of-actions pattern is what observability tools expect.
--
-- All columns nullable: chat_logs rows from /chat (no agent loop) leave
-- them empty.
-- ============================================================================

alter table public.chat_logs
  add column if not exists is_agent boolean default false,
  add column if not exists agent_iterations int,
  add column if not exists agent_tool_calls jsonb,
  add column if not exists agent_hit_iter_cap boolean default false;

comment on column public.chat_logs.is_agent is
  'True when this row records a /agent turn (vs a /chat turn). Lets /insights split agent vs plain-chat metrics.';

comment on column public.chat_logs.agent_tool_calls is
  'JSONB array of {iter, name, args, result_preview, ms, ok} — one entry per tool dispatch.';
