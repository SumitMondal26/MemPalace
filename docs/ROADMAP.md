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
- [x] Live trace UI in chat: pipeline stages with timings (planet for the eventual P3 agent traces)
- [x] Relevance threshold filter on retrieved chunks (0.4) so chat replies conversationally on out-of-context queries instead of hallucinating "I don't have that"
- [x] Sidebar slides in from the right on node-select; closes on background click

## P2 — Smarter retrieval ~ partially shipped

**Learning goal:** Real retrieval engineering — chunking strategies, hybrid search, reranking, evals, graph-augmented retrieval.

- [x] **Semantic edges** via `rebuild_semantic_edges` SQL function: pairwise cosine over node-mean embeddings, threshold-gated, idempotent. UI: "✨ Auto-connect" button in canvas; animated purple particles render semantic edges distinctly from manual.
- [x] **Evals harness**: JSON golden set + standalone Python runner (`make evals`) measuring recall@1/3/5/10 + MRR over the production retrieval path. A/B switching via `EVAL_STRATEGY` env var.
- [x] **Graph-augmented retrieval (1-hop)**: new `match_chunks_with_neighbors` SQL function — vector top-k + chunks from edge-connected nodes in one round-trip. Measured lift at stress test (k=1): recall@5 75%→100%, MRR 0.750→0.875.
- [ ] **Best-pair-chunk** for long docs: replace mean-of-chunks with max-similarity chunk pair when scoring node↔node. Fixes the "long doc connects to nothing because mean lives in a generic-topic zone" problem.
- [ ] **Hybrid retrieval**: vector + Postgres `tsvector` BM25-style fulltext, RRF-fused top-k. Catches exact-keyword matches (codenames, acronyms) that pure vector misses.
- [ ] **Reranking**: LLM-as-reranker over top-N→top-K, OR cross-encoder. Measure with evals.
- [ ] **Recursive token-aware chunking** that respects markdown headings + paragraph boundaries.
- [ ] **Multi-turn chat memory**: conversation history in the prompt; "what about her age?" works.
- [ ] **Redis + arq**: ingestion moves off the request path into background jobs.

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

- [ ] Tracing (OpenTelemetry → Langfuse or Phoenix)
- [ ] Faithfulness eval: LLM-as-judge verifies answer grounded in cited context
- [ ] Hallucination check: post-hoc verifier compares answer to retrieved context
- [ ] Memory compression: condense old clusters into summary nodes; preserve sources
- [ ] CI integration: evals run on every PR that touches retrieval / chunking / prompts

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

9. Create 3-4 short notes about related entities (e.g., "sumit", "sumit's age", "Eijuuu is sumit's gf"). Click **✨ Auto-connect** — semantic edges form between related notes; canvas shows animated purple particles.
10. `make evals` returns recall@5 ≥ 80% on the seeded golden set.
11. `EVAL_STRATEGY=match_chunks_with_neighbors EVAL_K_MAX=1 make evals` shows graph-RAG outperforms baseline (recall@5 100% vs ≤80%).

## Verification (P2 full) — pending

12. Long doc (PDF) auto-connects to relevant short notes after best-pair-chunk lands.
13. Hybrid retrieval rescues queries that mention exact tokens not strongly captured by embeddings.
14. Conversational chat: "what about X?" follow-up resolves the X via prior turn.
