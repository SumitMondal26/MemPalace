-- ============================================================================
-- chat_logs additions for query rewriting (P2 closer).
--
-- Query rewriting takes the user's latest turn + recent history and asks an
-- LLM to produce a standalone search query. The rewritten query is what the
-- retriever embeds. This closes the multi-turn weakness flagged in ADR-014:
-- the generator could see prior messages, but the retriever was blind to
-- them.
--
-- We log both the original and the rewritten query so /insights can show
-- exactly what was sent to the embedder, and so eval drift can be traced
-- back to a specific rewrite.
--
-- All columns nullable: when the feature flag is off we just don't write
-- them. Existing rows stay valid.
-- ============================================================================

alter table public.chat_logs
  add column if not exists original_question text,
  add column if not exists rewritten_question text,
  add column if not exists rewrite_ms int,
  add column if not exists rewrite_tokens_in int default 0,
  add column if not exists rewrite_tokens_out int default 0,
  add column if not exists rewrite_cost_usd numeric(10, 6) default 0;

comment on column public.chat_logs.original_question is
  'The user''s raw input. Same as `question` when no rewrite happened, otherwise differs.';

comment on column public.chat_logs.rewritten_question is
  'The standalone query produced by the rewriter and sent to the embedder. NULL when rewrite was skipped (no history, or feature off).';
