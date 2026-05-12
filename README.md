# Mem Palace

A visual AI memory system. Your knowledge as an interconnected graph of nodes — docs, images, URLs, notes — wired together by manual links and semantic similarity. Chat with your memory; let agents organize it.

> **Status:** P1 in progress. See [docs/ROADMAP.md](docs/ROADMAP.md).

## Stack

- **Web** — Next.js 15 (App Router) · TypeScript · Tailwind · Zustand · React Flow
- **API** — FastAPI · Python 3.12 · async
- **Data** — Supabase (Postgres + pgvector + Auth + Storage), hosted
- **AI** — OpenAI (embeddings + chat), Ollama later
- **Infra** — Docker Compose for dev

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

Full design: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) · Decisions: [docs/DECISIONS.md](docs/DECISIONS.md)

## Quickstart

```bash
# 1. Create a Supabase project at https://supabase.com
#    Project Settings → API → copy URL, anon key, service role key, JWT secret.

# 2. Set up env
cp .env.example .env
# Fill in SUPABASE_*, OPENAI_API_KEY.

# 3. Apply the migration (one-time)
#    Option A — Supabase CLI (recommended):
#       npm i -g supabase
#       supabase login
#       supabase link --project-ref <your-project-ref>
#       supabase db push
#    Option B — copy/paste supabase/migrations/0001_init.sql
#       into the SQL editor at app.supabase.com.

# 4. Boot
make dev          # or: docker compose up --build
```

Open <http://localhost:3000>. Sign up, create your first node, drop in a PDF, ask your memory a question.

## Project layout

```
apps/web/      Next.js app (UI, auth cookies, React Flow canvas)
apps/api/      FastAPI app (ingestion, RAG, agents)
supabase/      SQL migrations + seed
docs/          Architecture, decisions, roadmap, RAG notes
```

## Verifying it works

See the smoke test in [docs/ROADMAP.md](docs/ROADMAP.md#verification).

## Why these choices

Every non-obvious decision is captured in [docs/DECISIONS.md](docs/DECISIONS.md). Read those before changing the architecture.
