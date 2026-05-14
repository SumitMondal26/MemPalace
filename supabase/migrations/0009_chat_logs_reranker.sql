-- ============================================================================
-- chat_logs additions for the LLM-as-judge reranker (P2 closer #2).
--
-- The reranker takes top-N candidates from vector retrieval and asks
-- gpt-4o-mini to reorder them. Logging captures whether it actually fired
-- (sometimes we skip — clear winner / too few candidates / parse failure)
-- so /insights can show "this answer would have been wrong without rerank"
-- vs "this answer was already obvious."
--
-- All columns nullable: when the feature flag is off we just don't write
-- them. Existing rows stay valid.
-- ============================================================================

alter table public.chat_logs
  add column if not exists rerank_was_reranked boolean,
  add column if not exists rerank_skip_reason text,
  add column if not exists rerank_ms int,
  add column if not exists rerank_tokens_in int default 0,
  add column if not exists rerank_tokens_out int default 0,
  add column if not exists rerank_cost_usd numeric(10, 6) default 0;

comment on column public.chat_logs.rerank_was_reranked is
  'True only when the reranker actually called the LLM. False when skipped (clear winner, <2 candidates, or parse failure).';

comment on column public.chat_logs.rerank_skip_reason is
  'NULL when rerank fired. Otherwise a short tag: "clear winner (gap > 0.10)", "too few candidates", "rerank parse/api failure".';
