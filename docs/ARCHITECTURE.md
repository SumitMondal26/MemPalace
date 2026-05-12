# Architecture

> Living document. Updated as P1 → P4 unfold.

## System diagram

```
                      ┌────────────────────────┐
                      │      Browser           │
                      │  (React Flow, ChatUI)  │
                      └────────┬───────────────┘
                               │ HTTPS, auth cookie
                               ▼
   ┌──────────────────────────────────────────────────┐
   │  Next.js (apps/web)                              │
   │   - App Router, SSR-friendly Supabase client     │
   │   - Reads nodes/edges directly from Supabase     │
   │   - Forwards Bearer JWT to FastAPI for AI work   │
   └──────────┬──────────────────────────┬────────────┘
              │                          │
   direct, RLS-scoped              Bearer <JWT>
              │                          │
              ▼                          ▼
   ┌──────────────────┐         ┌──────────────────────┐
   │  Supabase Cloud  │         │  FastAPI (apps/api)  │
   │  - Postgres      │◀────────│  - JWT verify        │
   │  - pgvector      │  service│  - Chunking          │
   │  - Auth (GoTrue) │  role   │  - Embeddings        │
   │  - Storage       │  for    │  - Retrieval (pgvec) │
   │  - RLS policies  │  system │  - SSE chat stream   │
   └──────────────────┘  jobs   └──────────┬───────────┘
                                           │ HTTPS
                                           ▼
                                  ┌──────────────────┐
                                  │   OpenAI API     │
                                  │ (embed + chat)   │
                                  └──────────────────┘
```

## Why two services

The web tier handles UI, SSR, and auth cookies — Node's strength. The API tier handles AI work (chunking, embeddings, agent loops, evals) — Python's strength. They scale independently: chat traffic doesn't pressure the embedding pipeline, and vice-versa. Single-language stacks force trade-offs neither side wants.

## Trust boundaries

| Layer | Trusts | Verifies |
|---|---|---|
| Browser | Supabase auth cookie | — |
| Next.js | Cookie, server-side via `@supabase/ssr` | Validates session on every server render |
| FastAPI | `Authorization: Bearer <JWT>` from web | Signature against `SUPABASE_JWT_SECRET`; `auth.uid()` flows into Supabase queries |
| Postgres (RLS) | `auth.uid()` from incoming JWT | Policies on every table |

Two keys, two purposes:
- **Anon/user key**: used with the user's JWT. RLS applies. This is the default.
- **Service-role key**: used only for background system jobs (embedding pipeline, agent sweeps). Bypasses RLS — guard carefully.

## Data flow: ingestion

```
Upload → Supabase Storage (`uploads` bucket)
       → POST /ingest (JWT verified)
       → extract text (PDF parser / plain read)
       → chunking.py  (recursive, token-aware, overlap)
       → embeddings.py (OpenAI batch)
       → INSERT INTO chunks (..., embedding) USING service role
       → update uploads.status = 'processed'
```

## Data flow: chat (RAG)

```
User question
   → POST /chat (SSE)
   → embed question
   → retrieval.py: SELECT chunks ORDER BY embedding <=> q LIMIT k
   → build prompt (system + retrieved context + user)
   → llm.py: stream chat completion
   → SSE forwards tokens to browser
   → ChatPanel renders deltas
```

## Invariants

These should never break. If you change code that touches one, update this doc.

1. **No service-role key in the browser.** Audited via `NEXT_PUBLIC_*` prefix discipline.
2. **All app tables have RLS enabled** with workspace-scoped policies.
3. **Embedding dimension matches the model.** Change one ⇒ change the other ⇒ re-embed.
4. **Vectors live next to metadata.** No second vector store until pgvector measurably hurts.
5. **No LangChain in core paths** through P3. Agent loop and retrieval are hand-written.

## Open architectural questions (deferred)

- **Background job runner**: arq vs rq vs Celery — decided in P2 when we have real load.
- **Multi-workspace UX**: schema supports it; UI deferred to P3.
- **Production deploy targets**: Vercel (web) + Fly.io/Render (api). Compose stays dev-only.
