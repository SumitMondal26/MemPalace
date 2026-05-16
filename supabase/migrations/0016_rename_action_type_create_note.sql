-- ============================================================================
-- Rename agent_actions.action_type 'create_summary_node' → 'create_note'.
--
-- The v1 tool name (propose_summary_node) leaked an internal mental model
-- into the public name — it implied the tool was ONLY for summaries. In
-- reality the tool just creates a note with title + content + optional
-- source links. Users save lots of things that aren't summaries (lists,
-- journal entries, plain notes). Renaming to `create_note` makes the
-- tool's surface honest.
--
-- One-canonical-name approach (vs allowing both old + new): the audit
-- table has a handful of rows; rewriting them is cheap and avoids
-- forever-having-two-string-literals in the dispatch / UI / check
-- constraint. Audit history is preserved (rows still exist, with the
-- updated action_type value).
--
-- Order of operations matters: must drop the CHECK constraint before
-- UPDATE-ing the value (otherwise the UPDATE would fail validation
-- against the still-active check), then add the new check.
-- ============================================================================

alter table public.agent_actions
  drop constraint if exists agent_actions_action_type_check;

update public.agent_actions
  set action_type = 'create_note'
  where action_type = 'create_summary_node';

alter table public.agent_actions
  add constraint agent_actions_action_type_check
  check (action_type in ('create_note'));
