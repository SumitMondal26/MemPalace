-- ============================================================================
-- agent_actions — audit + state for write proposals made by the agent.
--
-- The agent's "write tools" (P3.3, starting with `propose_summary_node`)
-- don't write to the graph directly. They DECLARE INTENT — one row in
-- this table per proposal, status='pending'. The user reviews proposals
-- in the chat panel and approves/rejects each one via the
-- `/agent/proposals/{id}/{approve|reject}` endpoints, which transition
-- status and (on approve) actually perform the write.
--
-- Why a dedicated table:
--   - We need durable record of every proposal (approved AND rejected) for
--     audit. Inline in chat_logs.agent_tool_calls would lose state once
--     the row is written.
--   - We need to look up "is this proposal still valid to approve" — pending
--     vs already-executed-or-rejected.
--   - We need to attribute the resulting node back to the proposal that
--     created it (`result_node_id`).
--
-- Lifecycle:
--   status='pending'   — proposal exists, awaiting user review.
--   status='executed'  — user approved; write happened; result_node_id set.
--   status='rejected'  — user rejected; no write happened.
--
-- Transitions are one-way. Re-approving a rejected proposal isn't supported
-- (the agent can be re-asked to propose again).
--
-- payload jsonb shape (for action_type='create_summary_node'):
--   { "title": str, "content": str, "source_node_ids": [uuid, ...] }
--
-- RLS workspace-scoped via owner.
-- ============================================================================

create table public.agent_actions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  chat_log_id uuid references public.chat_logs(id) on delete set null,
  action_type text not null check (
    action_type in ('create_summary_node')
    -- v2: 'create_edge', 'rename_node', etc.
  ),
  payload jsonb not null,
  status text not null default 'pending' check (
    status in ('pending', 'executed', 'rejected')
  ),
  -- Foreign key to the node CREATED by an executed action. Set only when
  -- status transitions to 'executed'. On delete set null → user can delete
  -- the created node via the sidebar without breaking the audit row.
  result_node_id uuid references public.nodes(id) on delete set null,
  -- Optional reason from the agent for the proposal — passed through from
  -- the tool call, surfaced in /insights and in the approval card UI.
  reason text,
  proposed_at timestamptz default now(),
  executed_at timestamptz,
  rejected_at timestamptz
);

create index agent_actions_workspace_status_idx
  on public.agent_actions(workspace_id, status);

create index agent_actions_chat_log_idx on public.agent_actions(chat_log_id);

alter table public.agent_actions enable row level security;

create policy "own agent_actions" on public.agent_actions
  for all
  using (workspace_id in (select id from public.workspaces where owner_id = auth.uid()))
  with check (workspace_id in (select id from public.workspaces where owner_id = auth.uid()));
