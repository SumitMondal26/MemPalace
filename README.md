# Mem Palace

A visual AI memory system. Your knowledge as an interconnected graph of nodes — docs, images, URLs, notes — wired together by manual links and semantic similarity. Chat with your memory; the graph organizes itself; agents (P3) will read and extend it.

> **Status:** P1 ✅ · P2 🟢 ~95% (rewriter, reranker, clustering, graph UI sweep, media previews) · P3 🟡 20% (P3.1 agent loop shipped). See [docs/ROADMAP.md](docs/ROADMAP.md).

## What works today

- **3D memory canvas** — floating, glowing color-coded nodes connected by edges; auto-fit camera; particle field for atmosphere; optional Maya-style floor grid. Powered by `react-force-graph-3d` (three.js).
- **Auth + multi-user** — Supabase Auth (email+password), JWT round-trip into FastAPI, RLS at the DB layer for workspace isolation. JWT verifier supports both HS256 (legacy) and asymmetric JWKS keys.
- **Notes + docs + URLs** — create, edit, delete nodes; manual edges by drag (when re-enabled in P2); content auto-embeds on save so every memory is searchable.
- **PDF / text upload pipeline** — Supabase Storage → FastAPI extracts text → tiktoken-aware chunking → batched OpenAI embeddings → pgvector.
- **Chat with your memory** — POST /chat streams over SSE with a live trace (stage/sources/token/done events). Relevance threshold + relaxed grounding mean it answers "hello" conversationally and "what is multi-head attention?" with grounded citations.
- **Multi-turn conversation memory** — last 6 messages of each chat session sent as history; pronouns and follow-ups ("what about her age?") resolve naturally.
- **Auto-connect v2.1** — single SQL function does best-pair-chunk similarity (max over chunk-pair Cartesian) + kNN per node (top-3) + min-weight floor (0.25). No threshold tuning, no orphan nodes, no false-friend noise. Chain runs automatically after every save.
- **Graph-augmented retrieval** — `/chat` uses `match_chunks_with_neighbors`: vector top-k + 1-hop graph expansion in one DB round-trip. Measured: at stress test, recall@5 lifts 75% → 100%.
- **LLM query rewriting (multi-turn)** — before embedding, gpt-4o-mini rewrites pronoun-laden follow-ups ("how old is she?") into standalone search queries ("how old is Eijuuu?") using the last 4 turns. Skipped on single-turn (zero added cost). Measured: recall@1 +5pp, MRR +0.025.
- **LLM-as-judge reranker** — over-fetches 2× from retrieval, sends top-N candidates + question to gpt-4o-mini for reordering, takes top-K. Auto-skips on clear winner. Measured: recall@1 80→**95.24%**, MRR 0.885→**0.976** with rewriter+rerank stacked.
- **Agentic topic clustering** — `🏷 Recompute topics` runs sklearn MiniBatchKMeans on node-mean embeddings + per-cluster gpt-4o-mini labeling. Phase 1 scaling: members-hash reuse skips the LLM call when a cluster's membership is unchanged. Color-coded clusters in the 3D canvas, clickable legend with focus-others-dim.
- **Edge weight visualization** — discrete color tiers (slate/cyan/amber by similarity), legend in canvas corner, edge width + particle density modulated by weight.
- **Unified add-memory flow** — single "+ Add memory ▸" button → dropdown → type-aware draft form rendered inside the sidebar. Save chains: persist → embed → auto-connect → refresh edges.
- **Graph UI sweep** — substring node search top-left with `/` shortcut + camera fly-to · richer hover tooltips (node content preview, edge weight + endpoints) · cluster legend with focus interaction.
- **Inline media previews in sidebar** — YouTube/Vimeo iframe embeds, inline PDF viewer (signed-URL Storage objects), image preview, generic-URL link card. URL ingestion strips URLs from embedded text so the embedder sees only the prose signal.
- **🤖 Agent mode (P3.1)** — `POST /agent` runs a multi-step LLM-tools loop. Read-only tools today: `search_memory`, `read_node`, `list_clusters`, `read_cluster_members`. Hand-written agent loop, ~200 lines, no framework. Live SSE trace shows each tool call as a collapsible row in the chat panel. Self-heals from in-band errors (validated live: agent recovered from passing labels-as-UUIDs by calling `list_clusters` first).
- **Eval harness** — `make evals` runs a JSON golden set (21 cases) against the production retrieval path, reports recall@1/3/5/10 + MRR, supports A/B comparison via `EVAL_STRATEGY` / `EVAL_QUERY_REWRITE` / `EVAL_RERANK` env vars.
- **AI observability dashboard** — `/insights` page shows aggregate cost/latency/empty-context-rate, per-stage timing breakdown, recent-request list with drill-down to the raw prompt sent to OpenAI for any chat turn. Records both `/chat` and `/agent` rows (full tool-call trace as jsonb on agent rows).
- **In-chat raw-prompt panel** — every assistant message has a "▶ view raw prompt" expander showing the exact messages array sent to the LLM. Token counts + $ cost rendered inline.

## Stack

- **Web** — Next.js 15 (App Router) · TypeScript · Tailwind · Zustand · `react-force-graph-3d` · `@supabase/ssr`
- **API** — FastAPI · Python 3.12 · async · `python-jose` (JWT) · `tiktoken` · `pypdf` · `openai` · `supabase-py`
- **Data** — Supabase Cloud (Postgres + pgvector + Auth + Storage)
- **AI** — OpenAI `text-embedding-3-small` (1536-dim) + `gpt-4o-mini`. Local Ollama path planned.
- **Infra** — Docker Compose for dev. Production deploy planned to Vercel (web) + Fly.io/Render (api).

## Architecture in one diagram

```
[Browser]  --auth cookie-->  [Next.js (web)]  --Bearer JWT-->  [FastAPI (api)]
                                  |                                  |
                                  |  (RLS-scoped reads/writes)       |  (service role for
                                  v                                  v   system jobs)
                            [Supabase Postgres + pgvector + Storage + Auth]
                                                                     |
                                                                     v
                                                                [OpenAI API]
```

Two app containers in dev. Everything else (DB, auth, file storage) is hosted Supabase, reached over HTTPS.

Full design: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) · Decisions: [docs/DECISIONS.md](docs/DECISIONS.md) · Progress log: [docs/PROGRESS.md](docs/PROGRESS.md) · Study guide: [docs/LEARNING.md](docs/LEARNING.md)

## Quickstart

```bash
# 1. Create a Supabase project at https://supabase.com
#    Project Settings → API Keys + JWT Keys → copy URL, anon key,
#    service_role key, legacy JWT secret.
#    Authentication → Providers → Email → toggle off "Confirm email"
#    (lets dev signup work without verification round-trip).

# 2. Set up env
cp .env.example .env
# Fill in SUPABASE_*, OPENAI_API_KEY.

# 3. Apply the migrations (one-time)
#    Option A — Supabase CLI (recommended):
#       npm i -g supabase
#       supabase login
#       supabase link --project-ref <your-project-ref>
#       supabase db push
#    Option B — copy/paste each supabase/migrations/000N_*.sql
#       into the SQL editor at app.supabase.com, in order.

# 4. Boot
make dev          # or: docker compose up --build
```

Open <http://localhost:3000>. Sign up, create a few notes, upload a PDF, click "✨ Auto-connect", ask your memory a question.

## Useful commands

```bash
make dev        # dockerized dev (web + api with hot reload)
make down       # stop containers
make logs       # tail logs from all services
make health     # curl both health endpoints
make evals      # run retrieval evals (recall@k + MRR over golden set)
make help       # full list
```

A/B retrieval comparison (the same `make evals` harness, different env knobs):
```bash
# Baseline — vector only.
EVAL_STRATEGY=match_chunks make evals

# Graph-augmented — vector + 1-hop neighbor expansion.
EVAL_STRATEGY=match_chunks_with_neighbors make evals

# Stress: only top-1 chunk allowed. Shows graph-aug's recall lift starkly.
EVAL_K_MAX=1 EVAL_STRATEGY=match_chunks_with_neighbors make evals

# + LLM query rewriting on multi-turn cases (those with `history` in golden.json).
EVAL_QUERY_REWRITE=1 EVAL_STRATEGY=match_chunks_with_neighbors make evals

# Full stack — query rewriting + LLM-as-judge reranker (current best: recall@1 95%, MRR 0.976).
EVAL_QUERY_REWRITE=1 EVAL_RERANK=1 EVAL_STRATEGY=match_chunks_with_neighbors make evals
```

## Project layout

```
apps/web/      Next.js app (UI, auth cookies, 3D canvas, chat panel, /insights)
apps/api/      FastAPI app (ingest, chat, semantic edges, /me, observability writes)
apps/api/eval/ Eval harness (golden.json + run_evals.py)
supabase/      SQL migrations (init, storage, semantic-v1, graph-aug, semantic-v2,
               min-weight floor, chat_logs)
docs/          Architecture, decisions, roadmap, RAG notes, evals docs,
               study guide, progress log
```

## Verifying it works

See the smoke tests in [docs/ROADMAP.md](docs/ROADMAP.md#verification-p1-smoke-test--passing).

## Why these choices

Every non-obvious decision is captured in [docs/DECISIONS.md](docs/DECISIONS.md) (12 ADRs at last count). Read those before changing the architecture.

## Learning the project

If you're picking this up to learn AI engineering, read in this order:

1. [docs/LEARNING.md](docs/LEARNING.md) — the study guide, organized by concept
2. [docs/RAG_NOTES.md](docs/RAG_NOTES.md) — chunking, embeddings, retrieval rationale
3. [docs/EVALS.md](docs/EVALS.md) — how to measure RAG quality
4. [docs/PROGRESS.md](docs/PROGRESS.md) — what shipped when, with the lessons
5. [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — the system as it stands now
6. [docs/DECISIONS.md](docs/DECISIONS.md) — every load-bearing choice + why
