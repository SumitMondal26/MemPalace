-- ============================================================================
-- chat_logs additions for the reflection loop (P3.2).
--
-- After the agent produces a final answer, a judge model scores it 1-5 on
-- grounding + completeness. If score < 4 and we haven't already retried,
-- the agent gets one more attempt with the judge's issues as feedback.
--
-- Three nullable columns:
--   - reflection_score      score of the FINAL accepted answer (after retry
--                            if any). 1-5. NULL when reflection didn't run.
--   - reflection_retried    true iff we did the second attempt. Lets
--                            /insights split "passed first try" from
--                            "needed a retry".
--   - reflection_issues     judge's issues on the FINAL answer (often
--                            empty when score >= 4). Surfacing these in
--                            /insights helps debug "why did the agent
--                            still get this wrong even after retry".
--
-- All nullable: rows from /chat (no agent loop) and from /agent runs
-- with reflection disabled leave them empty.
-- ============================================================================

alter table public.chat_logs
  add column if not exists reflection_score int,
  add column if not exists reflection_retried boolean default false,
  add column if not exists reflection_issues text;

comment on column public.chat_logs.reflection_score is
  'Judge score of the final accepted answer, 1-5. NULL when reflection skipped.';

comment on column public.chat_logs.reflection_retried is
  'True iff the agent did a second attempt with the judge''s feedback.';
