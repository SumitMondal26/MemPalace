# Architecture

> Living document. Updated as P1 → P4 unfold. Reflects the state at commit `eb620a9` (P1 + partial P2).

## System diagram

```
                      ┌─────────────────────────────┐
                      │        Browser              │
                      │  (3D canvas, ChatPanel,     │
                      │   sliding Sidebar)          │
                      └────────┬────────────────────┘
                               │ HTTPS, auth cookie
                               ▼
   ┌───────────────────────────────────────────────────────┐
   │  Next.js (apps/web)                                   │
   │   - App Router, @supabase/ssr                          │
   │   - 3D force-directed canvas (react-force-graph-3d)    │
   │   - Reads nodes/edges directly from Supabase (RLS)     │
   │   - Forwards Bearer JWT to FastAPI for AI work         │
   │   - Calls /workspaces/{id}/rebuild-edges for           │
   │     auto-connect                                       │
   └──────────┬──────────────────────────┬─────────────────┘
              │                          │
   direct, RLS-scoped              Bearer <JWT>
              │                          │
              ▼                          ▼
   ┌──────────────────┐         ┌──────────────────────────┐
   │  Supabase Cloud  │         │  FastAPI (apps/api)      │
   │  - Postgres      │◀────────│  - JWT verify (HS256+    │
   │  - pgvector      │  service│    JWKS asymmetric)      │
   │  - Auth (GoTrue) │  role   │  - Chunking (tiktoken)   │
   │  - Storage       │  for    │  - Embeddings (batched)  │
   │  - RLS policies  │  system │  - Retrieval (graph-aug) │
   │  - SQL functions │  jobs   │  - SSE chat stream       │
   │    (match_chunks,│         └──────────┬───────────────┘
   │     match_*_with │                    │ HTTPS
   │     _neighbors,  │                    ▼
   │     rebuild_     │           ┌──────────────────┐
   │     semantic_    │           │   OpenAI API     │
   │     edges)       │           │ (embed + chat)   │
   └──────────────────┘           └──────────────────┘

                ┌────────────────────────┐
                │  Eval harness          │
                │  apps/api/eval/        │
                │  Direct SUPABASE +     │
                │  OpenAI access via     │
                │  service role.         │
                │  `make evals`          │
                └────────────────────────┘
```

## Why two services

The web tier handles UI, SSR, and auth cookies — Node's strength. The API tier handles AI work (chunking, embeddings, agent loops, evals) — Python's strength. They scale independently: chat traffic doesn't pressure the embedding pipeline, and vice-versa. Single-language stacks force trade-offs neither side wants.

## Trust boundaries

| Layer | Trusts | Verifies |
|---|---|---|
| Browser | Supabase auth cookie | — |
| Next.js | Cookie, server-side via `@supabase/ssr` | Validates session on every server render |
| FastAPI | `Authorization: Bearer <JWT>` from web | HS256 against `SUPABASE_JWT_SECRET`, OR ES256/EdDSA via JWKS depending on the token's `alg` header |
| Postgres (RLS) | `auth.uid()` from incoming JWT | Policies on every table |

Two keys, two purposes:
- **Anon/user key**: used with the user's JWT. RLS applies. This is the default for handler queries.
- **Service-role key**: used only for background system jobs (embedding pipeline, agent sweeps) and the eval harness. Bypasses RLS — guarded carefully.

## Data flow: ingestion (uploaded files)

```
Upload → Supabase Storage (`uploads` bucket, RLS-scoped to user_id path prefix)
       → POST /ingest (JWT verified)
       → user-context Supabase: SELECT node WHERE id = node_id (RLS check = authz)
       → service-role Supabase: storage.download(path)
       → extract_text (pypdf for PDFs, decode for text)
       → chunk_text (tiktoken cl100k_base, 500 tokens, 50-token overlap)
       → embed_batch (OpenAI batch, one call for all chunks)
       → DELETE chunks WHERE node_id = ?  // re-ingest is destructive
       → INSERT chunks (..., embedding vector(1536))
       → UPDATE uploads SET status = 'processed'
```

## Data flow: ingestion (typed note/url content)

```
User edits content → Save in Sidebar
                   → db.updateNode (direct Supabase, RLS)
                   → fire-and-forget POST /nodes/{id}/embed
                   → ownership check via user JWT
                   → DELETE existing chunks for node
                   → chunk + embed (single OpenAI call for short content)
                   → INSERT new chunks
                   → Sidebar shows "✓ N chunks indexed"
```

## Data flow: chat (graph-augmented RAG, multi-turn, observed, rewriter)

```
User question + prior 6 messages (history snapshot)
   → POST /chat (SSE response)
   → resolve workspace_id via supabase_user
   → IF history present AND settings.query_rewrite_enabled:
       → rewrite_query (gpt-4o-mini, temp 0, JSON mode, max 120 tokens)
       → emit SSE event: rewrite {original, rewritten, was_rewritten, elapsed_ms}
       → search_question = rewrite_result.rewritten   (else: body.question)
   → embed_query(search_question, OpenAI text-embedding-3-small)  → embed tokens captured
   → match_chunks_with_neighbors RPC:
       - top-k vector search (CTE: seed)
       - find seed nodes' 1-hop neighbors via edges (manual + semantic, undirected)
       - top-N chunks per neighbor node, ranked by query similarity
       - union seed + neighbor chunks, source-labeled, ordered seeds-first
   → filter chunks where similarity < 0.4 (RELEVANCE_THRESHOLD)
   → emit SSE event: sources [{i, id, node_id, similarity, source, preview}]
   → build prompt = system + history (capped 6) + current user-with-Context
   → emit SSE event: prompt {messages, model, temperature}    ← debug surface
   → llm.stream_chat_messages (stream_options.include_usage=true)
     → for each token, emit SSE event: token "..."
     → final event carries OpenAI usage (prompt_tokens, completion_tokens)
   → compute cost from per-model price table
   → emit SSE event: done {elapsed_ms, embed_tokens, prompt_tokens,
                            completion_tokens, cost_usd}
   → INSERT row into chat_logs (try/except — never blocks user response)
   → ChatPanel reads frames, dispatches:
       - trace rows (stage)
       - chips with click-to-expand previews (sources)
       - bubble content (token)
       - "view raw prompt" expandable panel (prompt)
       - total time + token + cost line (done)
```

## Data flow: semantic edges (auto-connect)

```
Click "✨ Auto-connect" in canvas
   → POST /workspaces/{id}/rebuild-edges
   → ownership check via user JWT (RLS on subsequent DELETE/INSERT enforces it)
   → SQL function rebuild_semantic_edges:
       - DELETE existing kind='semantic' edges for workspace
       - WITH node_emb AS (SELECT n.id, AVG(c.embedding)::vector(1536)
                           FROM nodes n JOIN chunks c ON c.node_id = n.id
                           WHERE n.workspace_id = ws_id
                           GROUP BY n.id)
       - WITH pairs AS (cross join with self, a.id < b.id, compute cosine)
       - INSERT INTO edges WHERE sim >= threshold (default 0.4)
   → return count of new edges
   → frontend refetches edges, updates Zustand store
   → 3D canvas renders with animated purple particles on semantic edges
```

## Data flow: unified add-memory + auto-connect chain

```
Click "+ Add memory ▸" → dropdown → pick type
   → store.startDraft(type)  (clears any selection, sets draftType)
   → Sidebar slides in with type-aware DraftForm
       - note: title + content
       - url:  title + URL + optional notes
       - doc:  title only (file upload after creation)
   → user fills + clicks Save
   → db.createNode(...) → row in `nodes`
   → store.upsertNode + selectNode (which clears draftType)
   → Sidebar transitions to edit-mode for new node
   → If type ∈ {note, url} AND content non-empty:
       - POST /nodes/{id}/embed
           → DELETE existing chunks for node
           → chunk + batch-embed via OpenAI
           → INSERT new chunks
       - POST /workspaces/{id}/rebuild-edges
           → SQL function: best-pair-chunk + kNN (K=3) + min-weight (0.25)
           → DELETE old kind='semantic' edges, INSERT fresh ones
       - db.listEdges(workspace_id) → store.setEdges
       - 3D canvas re-renders with new node + new edges + animated particles
   → If type = doc: user uploads file → /ingest → same chain triggered by
     UploadDropzone.onProcessed callback
```

## Data flow: AI observability (/insights)

```
[every chat turn writes one chat_logs row]
   ↓
/insights (server component)
   → supabaseServer().from("chat_logs").select("*").limit(100)  (RLS-scoped)
   → InsightsClient (client component)
       - 4 aggregate cards: Requests, Total cost, Avg latency (p95),
         Empty-context rate
       - Stage-timing breakdown bar (cyan embed / emerald search / amber llm)
       - Recent-requests list (left): cost/latency/tokens per row
       - Drill-down panel (right): every captured field for selected row,
         including the raw prompt with role-tagged messages
```

## Eval pipeline

```
make evals
  → apps/api/eval/run_evals.py
  → reads .env from repo root
  → load golden.json (8+ hand-curated cases: question + expected_node_titles)
  → for each case:
      → embed question (OpenAI, same model as production)
      → call match_chunks (or match_chunks_with_neighbors via EVAL_STRATEGY)
      → map chunks → unique node titles in rank order
      → find first rank where any expected title appears
  → aggregate: recall@1, recall@3, recall@5, recall@10, MRR
  → print per-case table + failure list (cases that miss recall@5)

A/B comparison:
  EVAL_STRATEGY=match_chunks make evals               # baseline
  EVAL_STRATEGY=match_chunks_with_neighbors make evals # graph-augmented
  EVAL_K_MAX=1 ... make evals                          # stress test
```

## Invariants

These should never break. If you change code that touches one, update this doc.

1. **No service-role key in the browser.** Audited via `NEXT_PUBLIC_*` prefix discipline.
2. **All app tables have RLS enabled** with workspace-scoped policies.
3. **Embedding dimension matches the model.** Change one ⇒ change the other ⇒ re-embed.
4. **Vectors live next to metadata.** No second vector store until pgvector measurably hurts.
5. **No LangChain in core paths** through P3. Agent loop and retrieval are hand-written.
6. **Every retrieval change is measured.** Run `make evals` before + after; record numbers in commit message.
7. **The graph is operational, not decorative.** `match_chunks_with_neighbors` is the default; semantic edges feed retrieval, not just rendering.
8. **JWT verification supports both HS256 and JWKS.** Don't downgrade — Supabase rotates and we shouldn't break.
9. **Every chat turn produces a chat_logs row.** Logging wrapped in try/except so it can never block the user response, but this is the substrate for /insights and any future observability work.
10. **The auto-connect chain runs after every memory mutation.** Save a note → embed → rebuild-edges → refresh store. No "remember to click Auto-connect."
11. **Conversation memory is local-only** (lives in ChatPanel's component state). No DB persistence. Capped at 6 messages at the API boundary.
12. **Rewriter never blocks the chat path.** All failures (parse error, API timeout, junk JSON) silently fall back to the original question. The rewrite must be defensive — a broken rewriter = degraded retrieval, not a broken `/chat`.

## Open architectural questions (deferred)

- **Background job runner**: arq vs rq vs Celery — decided in P2 when ingestion grows past inline-fast.
- **Multi-workspace UX**: schema supports it; UI deferred to P3.
- **Production deploy targets**: Vercel (web) + Fly.io/Render (api). Compose stays dev-only.
- **Edge weights in graph expansion**: today all 1-hop neighbors contribute equally regardless of edge weight. Could weight by `edges.weight` (semantic similarity) for smarter expansion.
- **Multi-hop graph traversal**: 1 hop today. 2-3 hops would help "how is X related to Y" queries; needs an agent loop, not pure SQL.
