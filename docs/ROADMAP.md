# Roadmap

Mem Palace is built in four phases. Each phase has a *learning goal* (what you should be able to explain in an interview) and a *deliverable* (what works end-to-end).

Status legend: `[x]` = shipped · `[~]` = partial / in flight · `[ ]` = not started.

## P1 — Foundation ✅ shipped

**Learning goal:** End-to-end RAG. Auth, storage, embeddings, vector retrieval, streaming.

- [x] Hosted Supabase project, migration applied, RLS verified with two users
- [x] `docker compose up --build` brings up web + api (~60s on first build)
- [x] Signup / login (Supabase Auth, email+password) with JWKS verification (handles legacy HS256 + asymmetric ES256/EdDSA)
- [x] Graph canvas: create, edit, delete nodes; manual edges; drag-to-position (replaced 2D React Flow with 3D force-directed in `react-force-graph-3d` for the brain-aesthetic)
- [x] Upload PDF/text → stored in Supabase Storage → linked to a node
- [x] Ingest pipeline: chunk (tiktoken, ~500 tokens, 50-token overlap) → embed (`text-embedding-3-small`) → store in `chunks`
- [x] `/chat` endpoint: top-k retrieval, OpenAI streaming via SSE
- [x] Chat panel renders tokens live with stage/sources/token/done event trace

### P1 polish (also shipped)

- [x] Embed-on-save for note + url nodes (every memory becomes RAG-searchable, not just uploads)
- [x] Sidebar surfaces existing chunk count + current uploaded file per node
- [x] Live trace UI in chat: pipeline stages with timings (substrate for P3 agent traces)
- [x] Relevance threshold filter on retrieved chunks (0.4) so chat replies conversationally on out-of-context queries instead of hallucinating "I don't have that"
- [x] Sidebar slides in from the right on node-select; closes on background click

## P2 — Smarter retrieval 🟢 ~70% shipped

**Learning goal:** Real retrieval engineering — chunking strategies, reranking, evals, graph-augmented retrieval, observability.

### Shipped

- [x] **Semantic edges (auto-connect v1)** via SQL function — pairwise cosine over node-mean embeddings, idempotent.
- [x] **Auto-connect v2** — replaces threshold tuning with **best-pair-chunk** similarity (max over chunk-pair Cartesian) + **kNN per node** (each node gets top-K most-similar partners). Long docs now connect properly via best-pair-chunk; threshold knob is gone.
- [x] **Auto-connect v2.1** — adds a **min-weight floor** (0.25) on top of kNN to drop surface-form false-friend edges that kNN otherwise forces in.
- [x] **Evals harness** — JSON golden set + standalone Python runner (`make evals`) measuring recall@1/3/5/10 + MRR. A/B switching via `EVAL_STRATEGY` env var.
- [x] **Graph-augmented retrieval (1-hop)** — `match_chunks_with_neighbors` SQL function: vector top-k + 1-hop edge expansion in one round-trip. Measured lift at stress test (k=1): recall@5 75%→100%, MRR 0.750→0.875.
- [x] **Multi-turn chat memory** — client snapshots prior 6 messages, sends as `history`; server splices between system prompt and current Context. ADR-014 documents the design + the known weakness (vague follow-ups still embed poorly — query rewriting is the next layer).
- [x] **AI observability** — `chat_logs` table records one row per chat turn (question, answer, full prompt, cited node IDs, model meta, retrieval stats, per-stage timings, token counts, $ cost, status). New `/insights` page shows aggregates + per-row drill-down with the raw prompt. Originally planned for P4; pulled forward because debugging the gym-question hallucination needed it.
- [x] **Edge weight visualization** — discrete color tiers (slate/cyan/amber by weight), legend in canvas corner, edge width + particle density modulated by weight. Force simulation tuned for spaced layout.
- [x] **Unified add-memory flow** — single "+ Add memory ▸" button → dropdown → type-aware draft form rendered inside the sidebar (no modal layer). Save chains automatically: persist → embed → auto-connect → refresh edges. Zero clicks-to-connect.

### Remaining (still P2)

- [ ] **Hybrid retrieval** — vector + Postgres `tsvector` BM25-style fulltext, RRF-fused top-k. Catches exact-keyword matches (codenames, acronyms) that pure vector misses.
- [ ] **Reranking** — LLM-as-reranker over top-N→top-K, OR cross-encoder. Measure with evals.
- [ ] **Recursive token-aware chunking** that respects markdown headings + paragraph boundaries.
- [ ] **Query rewriting for multi-turn** — one LLM call uses prior turns to rewrite vague follow-ups into self-contained search queries before embedding. Fixes the multi-turn weakness in ADR-014.
- [ ] **Redis + arq** — ingestion moves off the request path into background jobs.

## P3 — Agents

**Learning goal:** Tool-using agents, reflection loops, multi-step orchestration without LangChain.

- [ ] Tool spec: `search_memory`, `read_node`, `link_nodes`, `summarize_cluster`, `create_node`
- [ ] Memory agent: clusters related nodes, writes summaries as new nodes
- [ ] Retrieval agent: rewrites queries, decides between vector / fulltext / graph traversal
- [ ] Reflection loop: critique-and-retry on low-confidence retrievals
- [ ] Research agent: takes a question, expands the graph from web results
- [ ] Trace UI extended: same SSE channel carries `tool_call` / `tool_result` / `reflection` events

## P4 — Observability & quality

**Learning goal:** AI you can debug, measure, and trust.

- [x] **Per-request observability** (chat_logs + /insights) — *pulled forward into P2; see above.*
- [ ] Tracing (OpenTelemetry → Langfuse or Phoenix) — replace in-house chat_logs with a vendor when scale demands.
- [ ] Faithfulness eval: LLM-as-judge verifies answer grounded in cited context (would have caught the gym-question hallucination automatically).
- [ ] Hallucination check: post-hoc verifier compares answer to retrieved context.
- [ ] Memory compression: condense old clusters into summary nodes; preserve sources.
- [ ] CI integration: evals run on every PR that touches retrieval / chunking / prompts.
- [ ] Time-series charts on /insights: cost-over-time, latency histograms, top-cited nodes.

---

## Verification (P1 smoke test) — passing

After P1 ships, this should pass end-to-end (and does):

1. `docker compose up --build` — both containers green within ~60s.
2. <http://localhost:3000>, sign up with a fresh email.
3. Supabase SQL editor: `select * from profiles, workspaces` shows the trigger-created rows.
4. Create a text note "Transformer architecture intro" with a paragraph of content. Save.
5. Upload a PDF to a new doc node.
6. `select count(*) from chunks` is non-zero; FastAPI logs show chunking + embedding.
7. Chat panel: ask *"What is multi-head attention?"* — tokens stream, answer cites uploaded content.
8. Sign up as second user; confirm zero cross-user visibility (RLS works).

## Verification (P2 partial) — passing

9. Create 3-4 short notes about related entities. Click **+ Add memory ▸ → Note** — sidebar slides in with form. After Save, semantic edges form automatically.
10. `make evals` returns recall@5 ≥ 80% on the seeded golden set.
11. `EVAL_STRATEGY=match_chunks_with_neighbors EVAL_K_MAX=1 make evals` shows graph-RAG outperforms baseline (recall@5 100% vs ≤80%).
12. Multi-turn: ask "what is multi-head attention?", then "how many heads do they use?" — second question resolves "they" via prior turn.
13. Open `/insights` — see all chat turns logged with cost, latency, full prompt.
14. Click "view raw prompt" under any chat answer — see the exact messages array sent to OpenAI.

## Verification (P2 full) — pending

15. Hybrid retrieval rescues queries that mention exact tokens not strongly captured by embeddings.
16. Recursive chunker produces structurally-aware chunks for markdown-heavy content.
17. Query rewriting lifts MRR on follow-up questions in the eval set.
