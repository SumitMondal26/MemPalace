# Mem Palace

A visual AI memory system. Your knowledge as an interconnected graph of nodes — docs, images, URLs, notes — wired together by manual links and semantic similarity. Chat with your memory; the graph organizes itself; agents (P3) will read and extend it.

> **Status:** P1 ✅ shipped · P2 ~ partially shipped (semantic edges, evals, graph-augmented retrieval). See [docs/ROADMAP.md](docs/ROADMAP.md).

## What works today

- **3D memory canvas** — floating, glowing color-coded nodes connected by edges; auto-fit camera; particle field for atmosphere; optional Maya-style floor grid. Powered by `react-force-graph-3d` (three.js).
- **Auth + multi-user** — Supabase Auth (email+password), JWT round-trip into FastAPI, RLS at the DB layer for workspace isolation. JWT verifier supports both HS256 (legacy) and asymmetric JWKS keys.
- **Notes + docs + URLs** — create, edit, delete nodes; manual edges by drag (when re-enabled in P2); content auto-embeds on save so every memory is searchable.
- **PDF / text upload pipeline** — Supabase Storage → FastAPI extracts text → tiktoken-aware chunking → batched OpenAI embeddings → pgvector.
- **Chat with your memory** — POST /chat streams over SSE with a live trace (stage/sources/token/done events). Relevance threshold + relaxed grounding mean it answers "hello" conversationally and "what is multi-head attention?" with grounded citations.
- **Auto-connect (semantic edges)** — "✨ Auto-connect" button computes pairwise cosine over node-mean embeddings via a single SQL function and inserts edges. Threshold-tunable. Animated purple particles flow along semantic edges in the 3D canvas.
- **Graph-augmented retrieval** — `/chat` now uses `match_chunks_with_neighbors`: vector top-k + 1-hop graph expansion in one DB round-trip. Measured: at stress test, recall@5 lifts 75% → 100%.
- **Eval harness** — `make evals` runs a JSON golden set against the production retrieval path, reports recall@1/3/5/10 + MRR, supports A/B comparison via `EVAL_STRATEGY` env var.

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

A/B retrieval comparison:
```bash
EVAL_STRATEGY=match_chunks make evals                     # baseline
EVAL_STRATEGY=match_chunks_with_neighbors make evals      # graph-augmented
EVAL_K_MAX=1 EVAL_STRATEGY=match_chunks_with_neighbors make evals  # stress test
```

## Project layout

```
apps/web/      Next.js app (UI, auth cookies, 3D canvas, chat panel)
apps/api/      FastAPI app (ingest, chat, semantic edges, /me)
apps/api/eval/ Eval harness (golden.json + run_evals.py)
supabase/      SQL migrations (init, storage, semantic edges, graph-aug)
docs/          Architecture, decisions, roadmap, RAG notes, evals docs, study guide, progress log
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
