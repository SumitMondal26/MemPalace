-- ============================================================================
-- chat_logs.reflection_score_first — split out the first-attempt judge score
-- so /insights can distinguish "shipped" from "rejected" attempts.
--
-- Why this exists (post-audit lesson):
-- Migration 0013 stored a single `reflection_score`. We treated it as "the
-- score of the final accepted answer." But the audit caught a subtle issue:
-- when retry happens, the chip showed `judge 2/5` next to a corrected answer
-- the user actually liked. The user couldn't tell whether 2/5 was the
-- shipped answer's quality or the rejected one's.
--
-- New shape after this migration:
--   reflection_score        — score of the SHIPPED answer (max of the two
--                              attempts when retry happened)
--   reflection_score_first  — score of the first attempt (always set when
--                              reflection ran). When reflection_retried is
--                              false, equals reflection_score.
--   reflection_retried      — bool, unchanged
--   reflection_issues       — judge's issues on the REJECTED attempt; empty
--                              when no retry. Tells you "why we retried."
--
-- All additions nullable. Existing rows are interpretable: their old
-- reflection_score is still the "shipped" score; reflection_score_first
-- can be backfilled from reflection_score for rows where retried=false.
-- ============================================================================

alter table public.chat_logs
  add column if not exists reflection_score_first int;

comment on column public.chat_logs.reflection_score_first is
  'Judge score of the first attempt. When reflection_retried is false, equals reflection_score (which is the shipped answer''s score).';
