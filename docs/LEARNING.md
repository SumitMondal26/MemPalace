# Mem Palace — P1 Study Guide

What you built, what each piece *means*, why we made the choices we made, and the soundbites to use in interviews. Read top to bottom once; come back to sections when needed.

---

## 0. What you built (one paragraph)

A visual AI memory graph. Users sign up, create nodes (notes / docs / URLs), drag them around a canvas, connect them with edges, and chat with their memory. Behind the scenes: every node's content is chunked, embedded with OpenAI, and stored in pgvector. Chat questions get embedded, top-k chunks are retrieved by cosine similarity, the model composes an answer that cites those chunks, and the whole pipeline streams over Server-Sent Events with a live trace in the UI.

Two services (Next.js web + FastAPI api), one managed backend (Supabase: Postgres + pgvector + Auth + Storage), `docker compose up --build` for dev.

---

## 1. The big concepts

For each: **what it is**, **why it matters**, **where it lives in our code**, **interview soundbite**.

### 1.1 Retrieval-Augmented Generation (RAG)

**What.** Instead of asking the model what *it* knows, you (a) retrieve relevant text from your own data, (b) stuff it into the prompt as context, (c) ask the model to answer using *that* context. The model becomes a stateless reasoner over data you control.

**Why.** Three reasons in one breath:
1. **Freshness** — the model's training data is frozen; your data isn't.
2. **Citations** — you can prove where the answer came from (no "trust me bro").
3. **Privacy + cost** — you don't fine-tune; you bring your own context only when needed.

**Where in our code.**
- `apps/api/app/services/retrieval.py` — `embed_query` + `search_chunks`
- `apps/api/app/services/llm.py` — prompt assembly + streaming
- `supabase/migrations/0001_init.sql` — `match_chunks` RPC

**Soundbite.** *"RAG is grounding generation in retrieval. The model is the language engine; the vector DB is the knowledge engine. They're decoupled, which means I can swap either independently."*

---

### 1.2 Embeddings & vector search

**What.** An embedding is a fixed-size vector of floats (we use 1536 dims) that represents the *meaning* of a chunk of text. Two pieces of text that mean similar things end up close in this 1536-dimensional space. Distance is usually cosine similarity (the angle between the vectors, not the raw distance).

**Why.** Lets you search by *meaning* instead of keywords. "What is multi-head attention?" finds the chunk that says "Multi-head attention performs attention in parallel..." even though the chunk doesn't contain the exact phrase "what is".

**Where in our code.**
- Embedding generation: `embeddings.embed_batch` (OpenAI `text-embedding-3-small`)
- Storage: `chunks.embedding vector(1536)` in `0001_init.sql`
- Search: the `match_chunks` RPC orders by `embedding <=> query_embedding` (`<=>` is the pgvector cosine distance operator).

**Soundbite.** *"Embeddings turn text into points in geometric space; retrieval is nearest-neighbor search in that space. Cosine similarity because we care about direction (semantic angle), not magnitude (text length)."*

---

### 1.3 pgvector vs dedicated vector DBs

**What.** pgvector is a Postgres extension that adds a `vector` column type and similarity operators. Alternatives: Pinecone, Weaviate, Qdrant, Milvus — dedicated vector databases.

**Why pgvector for us.**
- **Co-location**: chunks live next to their metadata. JOINs work. One backup story. One auth model.
- **Free.** No additional service.
- **Performance ceiling is ~10M vectors** with HNSW. Past that you graduate.
- **You graduate by measuring pain**, not by reading blog posts about scale.

**Why a dedicated vector DB later.** Sub-millisecond p99 at hundreds of millions of vectors. Sharding. Specialized indexes.

**Soundbite.** *"Most production RAG starts on pgvector. You move to a dedicated store when you measure latency at recall, not theoretically."*

---

### 1.4 Chunking

**What.** Splitting long text into smaller pieces (we target ~500 tokens with 50-token overlap) before embedding.

**Why chunk at all?** Two reasons:
1. **Embedding quality**. Embedding "the whole paper" produces one blurry vector. Embedding 500-token chunks produces specific vectors that match specific questions.
2. **Context window**. The chat completion has a limited input budget. Top-k of small chunks fits; one giant chunk doesn't.

**Why tokens, not characters?**
- The model thinks in tokens. A 1000-char chunk could be 250 tokens (English prose) or 600 tokens (dense code). Token chunking gives consistent semantic density.
- We use `tiktoken.cl100k_base` — the same tokenizer family as GPT-4 / GPT-4o-mini / text-embedding-3-*.

**Why overlap?**
- A sentence might straddle a chunk boundary. Overlapping ~10% means at least one chunk preserves the full sentence intact, so retrieval doesn't miss it.

**Open questions (P2 work).**
- **Recursive splitting** (paragraph → sentence → token) preserves structure better.
- **Adaptive chunk size**: code wants bigger windows; tables want different handling.
- **Late chunking**: embed long context, slice the resulting attention, more expensive but preserves cross-chunk semantics.

**Where in our code.** `apps/api/app/services/chunking.py` — `chunk_text`.

**Soundbite.** *"Chunk size is the knob that trades retrieval precision against context completeness. ~500 tokens with 10% overlap is the boring-but-strong baseline. I'd measure recall@k on a golden set before optimizing further."*

---

### 1.5 Indexes: HNSW vs IVFFlat

**What.** Exact nearest-neighbor search at scale is O(n) per query. Approximate Nearest Neighbor (ANN) indexes trade tiny accuracy loss for huge speed gains.

- **HNSW** (Hierarchical Navigable Small Worlds) — multi-layer graph, ~O(log n) queries, more memory.
- **IVFFlat** — inverted file index, cluster centroids; faster build, slower query.

**Why HNSW for us.** pgvector >= 0.5 supports it. Better recall-vs-latency at our scale. Slightly higher memory cost which is irrelevant until ~1M vectors.

**Where in our code.** `0001_init.sql`:
```sql
create index chunks_embedding_idx on chunks
  using hnsw (embedding vector_cosine_ops);
```

**Soundbite.** *"HNSW for query speed, IVFFlat for cheap builds at scale. We picked HNSW because we're query-heavy and far from a memory ceiling."*

---

### 1.6 JWT authentication (HS256 vs JWKS / asymmetric)

**What.** JWT = JSON Web Token, a base64-encoded JSON payload with a signature. The signature proves the token wasn't tampered with.

Two signing approaches:
- **HS256 (symmetric)**: HMAC with a shared secret. Whoever has the secret can both sign and verify.
- **ES256 / EdDSA / RS256 (asymmetric)**: public/private key pair. Only the signer has the private key; verifiers use the public key (fetched from a JWKS endpoint). Public keys never need to be secret.

**Why both in our code.** Supabase has historically used HS256 with a shared `JWT_SECRET`. Newer projects default to asymmetric keys. The `anon` / `service_role` keys are still HS256 (they're static, long-lived API keys); user tokens (issued by GoTrue on login) are now asymmetric on new projects.

**Where in our code.** `apps/api/app/deps.py::get_claims`:
- Reads the unverified JWT header → finds `alg`
- HS256 → verify with `SUPABASE_JWT_SECRET`
- ES256 / EdDSA / RS256 → fetch JWKS from `<supabase_url>/auth/v1/.well-known/jwks.json`, look up key by `kid`, verify with public key
- On unknown `kid`, evict JWKS cache and retry once (handles rotation)

**Soundbite.** *"Asymmetric JWT signing means the public key can be everywhere — CDN-cacheable, no rotation drama, no secret sharing. JWKS is the standard way to publish public keys. Our code supports both legacy HS256 and JWKS so the verifier doesn't break when Supabase rotates anything."*

---

### 1.7 Row-Level Security (RLS) and the two-key pattern

**What.** Postgres feature: every query against a table is filtered through a policy that runs with each user's identity. The auth system (here, Supabase Auth) sets `auth.uid()` based on the JWT. The policy uses that to scope rows.

**Why.** Security at the database layer, not the app layer. A bug in your handler can't leak data because Postgres refuses the query.

**The two-key pattern.** Supabase exposes:
- **anon / user keys** — for user-context calls. RLS applies. The user's JWT is forwarded.
- **service_role key** — bypasses RLS. For system jobs (background embedding, agent sweeps).

Mix them deliberately in one handler:
1. **Authenticate** via JWT (`get_user_id`).
2. **Authorize** via user-context Supabase client: a `SELECT` will return zero rows if RLS rejects, so we know the user owns the node.
3. **Work** with service-role client (or user-context if RLS still scopes correctly).

**Where in our code.**
- Every app table has `enable row level security` + a `workspace_id IN (...)` policy in `0001_init.sql`.
- `apps/api/app/routers/ingest.py` shows the two-key pattern in action: user-context for the ownership check, service-role for the heavy lifting.

**Soundbite.** *"RLS is defense in depth — the floor, not the only line. The 'two-key' pattern: user JWT for authentication and authorization, service-role only for explicit background work. Never mix them in one query path by accident."*

---

### 1.8 Server-Sent Events (SSE) and streaming

**What.** SSE is a simple HTTP-based streaming protocol. Server sends one-way frames:
```
event: <name>
data: <json or text>
<blank line>
```
Browser consumes with `EventSource` or by parsing a `fetch().body` stream.

**Why SSE for LLM streaming.**
- One-way matches the LLM token output. No need for full-duplex.
- Plays nicely with HTTP infra (proxies, load balancers).
- Simple to implement; built into browsers via `EventSource`.
- Auto-reconnect baked in.

**Why we use `fetch().body` not `EventSource`.** `EventSource` is GET-only. Our `/chat` needs POST with `Authorization` header, so we parse the SSE stream manually from the fetch response.

**Where in our code.**
- Server: `apps/api/app/routers/chat.py` — `StreamingResponse` yielding `event: token\ndata: "..."` frames.
- Client: `apps/web/components/ChatPanel.tsx::consumeStream` — splits buffer on `\n\n`, parses each frame.

**Soundbite.** *"SSE for token streaming. WebSockets only when I need full duplex — chat with a bot doesn't."*

---

### 1.9 The trace channel design

**What.** Our `/chat` SSE emits multiple event types: `stage`, `sources`, `token`, `done`. The UI renders them as a live trace.

**Why this matters.**
- **Observability for free**: see where latency lives without external tools.
- **UX**: users perceive responsiveness even before tokens arrive ("Searching memory…" beats a spinner).
- **P3-ready**: when we add real agents, the same channel carries `tool_call`, `tool_result`, `reasoning`, `reflection` events. UI extends without rework.

**The honest framing.** Today there's no agent — just a 3-stage RAG pipeline. The trace shows that *truthfully*. In P3 it shows tool use *truthfully*. Same channel.

**Where in our code.** `apps/api/app/routers/chat.py` (server emits) and `apps/web/components/ChatPanel.tsx::Trace` (UI renders).

**Soundbite.** *"I designed the SSE channel as an extensible event log: stage / sources / token / done today, plus tool_call / reflection in P3. The UI is the same — only the events become richer."*

---

### 1.10 Async Python + FastAPI

**What.** FastAPI is built on Starlette + ASGI. Handlers are `async def`. Concurrency is cooperative — when one request awaits I/O (OpenAI call, DB query), the event loop runs other requests.

**Why async here.** RAG is dominated by I/O wait: ~100ms embedding + ~50ms DB + 1–3s OpenAI stream. With sync FastAPI workers, one slow chat blocks others. Async multiplexes them on one worker.

**Where in our code.**
- All routers are `async def`
- OpenAI SDK uses `AsyncOpenAI`
- Heavy ops await: `await embed_batch(...)`, `async for token in stream_chat(...)`

**Soundbite.** *"FastAPI async is the right fit for AI workloads — they're I/O-bound. One worker holds a hundred in-flight LLM streams cheaply."*

---

### 1.11 Next.js App Router (Server Components, Middleware, @supabase/ssr)

**What.** Next 15's App Router has two component flavors:
- **Server Components** (default) — run on the server, fetch data directly, ship zero JS to the browser. Async by default.
- **Client Components** (`"use client"` at top) — run in the browser, can use hooks, handle interactivity.

**Why this mix.**
- Server-render the initial graph page with the user's nodes already in HTML → no spinner flash on cold load.
- Client component handles the canvas (React Flow, drag, Zustand) — needs hooks.

**Middleware** runs on every matched request. We use `@supabase/ssr`'s pattern to:
- Refresh the session cookie if it's about to expire.
- Redirect away from protected routes when there's no session.

**Where in our code.**
- `apps/web/middleware.ts` — the cookie-refresh / redirect gate.
- `apps/web/lib/supabase-server.ts` — server-component client factory (async `cookies()` in Next 15).
- `apps/web/app/graph/page.tsx` — server component that fetches the workspace + initial nodes server-side.
- `apps/web/app/graph/GraphPageClient.tsx` — client component for the interactive UI.

**Soundbite.** *"Server components for data-fetching and auth gates, client components for interactivity. Middleware refreshes session cookies on every request so tokens don't silently expire mid-session."*

---

### 1.12 Two-tier state: Zustand mirrors DB, React Flow owns transient UI

**What.**
- **Zustand** holds the server-mirror — what's actually in Supabase right now (nodes, edges, selection).
- **React Flow's internal state** holds *transient* UI — position-while-dragging.
- On `onNodeDragStop`, we commit position to Supabase, then update Zustand, which re-syncs into React Flow.

**Why this split.** Two competing needs:
1. Mid-drag updates need to be 60fps smooth (no network).
2. Final state needs to be persistent (network required).

The drag-stop event is the *commit boundary*.

**Where in our code.**
- `apps/web/lib/store.ts` — Zustand slice.
- `apps/web/components/GraphCanvas.tsx` — React Flow integration, drag-stop handler.

**Soundbite.** *"Two state systems on purpose: Zustand as the durable mirror, React Flow's local state for transient interactions. The drag-stop event is where they reconcile. Same pattern Figma, Miro, Linear use under the hood."*

---

### 1.13 Supabase internals (what's actually running)

**What Supabase is.** A bundle of services around managed Postgres:
- **PostgREST** — auto-generates a REST API from your schema.
- **GoTrue** — auth service (signup, login, password reset, magic links, OAuth).
- **Storage** — S3-style object storage with its own RLS policies.
- **Realtime** — Postgres-change pub/sub (we don't use it in P1).
- **Studio** — the web dashboard.

**What we depend on.** Postgres (with pgvector + pgcrypto), GoTrue, Storage. That's it.

**Why hosted over self-hosted.** Self-hosted = ~10 containers. Hosted = `docker compose up` runs only your app code. Faster dev loop, closer to what most AI startups actually ship.

**Soundbite.** *"Supabase is a managed bundle: Postgres + GoTrue + Storage + PostgREST. I picked it because it removes ~10 containers of infra from my dev setup, lets me ship the AI layer faster."*

---

## 2. Architecture (the system)

### 2.1 Two-service split: why?

| Layer | Owns | Why this language/framework |
|---|---|---|
| Next.js (web) | UI, SSR, auth cookies, direct DB reads | React ecosystem, App Router, cookie-friendly Supabase SSR |
| FastAPI (api) | Chunking, embedding, retrieval, chat stream, future agents | Python AI ecosystem (OpenAI, tiktoken, evals libs, agent frameworks) |
| Supabase | Postgres + pgvector + Auth + Storage + RLS | Managed; one source of truth; co-located vectors+metadata |

A single Node BFF could *call* OpenAI but couldn't natively use Python-only tooling. Splitting also lets each tier scale independently.

### 2.2 Trust boundaries

| Layer | Trusts | Verifies |
|---|---|---|
| Browser | Supabase auth cookie | nothing locally |
| Next.js middleware | Session cookie from browser | calls `supabase.auth.getUser()` on each request |
| FastAPI | `Authorization: Bearer <JWT>` | HS256 secret or JWKS public key |
| Postgres (RLS) | `auth.uid()` derived from forwarded JWT | every query against every app table |

**Defense in depth.** A bug in any single layer doesn't compromise data — there are three policies guarding access.

### 2.3 Three flows worth knowing cold

**Signup flow.**
1. User submits email+password to Next.js login page → `supabase.auth.signUp(...)`.
2. GoTrue creates row in `auth.users` (a Supabase-managed schema).
3. Our `on_auth_user_created` trigger fires (`SECURITY DEFINER`, `search_path=public`):
   - Inserts a row into `public.profiles` (mirrors auth.users.id).
   - Inserts a row into `public.workspaces` (one per user in P1).
4. JWT is issued; cookie is set.
5. Browser navigates to `/graph`.

**Ingest flow.**
1. User clicks **Upload** in a doc node's sidebar.
2. Browser uploads directly to Supabase Storage at path `<user_id>/<node_id>/<timestamp-filename>`. Storage RLS enforces the first path segment matches `auth.uid()`.
3. Browser POSTs to FastAPI `/ingest` with `{ node_id, storage_path }` + Bearer JWT.
4. FastAPI verifies JWT, runs ownership check via user-context Supabase client (RLS does the work).
5. FastAPI downloads the file via service-role Supabase client.
6. `extract_text` (pypdf for PDFs, decode for text) → `chunk_text` (tiktoken, 500-token windows, 50-token overlap) → `embed_batch` (one OpenAI call for all chunks).
7. Delete existing chunks for this node (re-ingest is destructive), insert new ones.
8. Mark `uploads.status = 'processed'`. Return chunk count.

**Chat flow.**
1. User types question in ChatPanel → POST `/chat` with Bearer JWT, body `{ question, k }`.
2. FastAPI starts SSE stream.
3. `event: stage` "Encoding your question" → `embed_query` (OpenAI).
4. `event: stage` "Searching memory" → `search_chunks` (pgvector RPC, RLS-scoped).
5. `event: sources` with top-k chunks (id, similarity, preview).
6. `event: stage` "Composing answer from N chunks" → `stream_chat` (OpenAI chat completion, `stream=True`).
7. Many `event: token` frames as deltas arrive from OpenAI.
8. `event: done` with total elapsed_ms.

---

## 3. Caveats (the honest list of what P1 doesn't have)

These are not failures — they're scoped tradeoffs. Each is worth a sentence in an interview:

1. **Ingestion is synchronous.** The HTTP request blocks for 1–5s while we chunk + embed. P2 moves it behind Redis + arq (background queue).
2. **No eval harness.** We can't currently measure retrieval quality. P4 adds a golden Q→A set and recall@k / faithfulness metrics.
3. **No reranking.** Top-k by raw cosine. Adding a cross-encoder reranker (or LLM reranker) typically lifts recall by 10-20pp.
4. **No hybrid retrieval.** Pure vector search misses exact-keyword queries (codenames, acronyms). P2 adds Postgres `tsvector` + RRF fusion.
5. **No real agents.** Despite the trace UI, today's "agent" is a fixed pipeline. P3 adds tool-calling, reflection loops, query rewriting.
6. **No observability/tracing.** We see request logs; we don't see token usage, model latency, retrieval recall, or per-trace cost. P4 adds OpenTelemetry → Langfuse/Phoenix.
7. **Race window on rapid embed.** Two saves within 1s on the same note can produce duplicate chunks (delete-then-insert isn't transactional). Acceptable for P1; fixed by P2's queue (single writer per node).
8. **No tests.** Not a single one. We've leaned on observable verification. P2 adds unit tests for chunking + retrieval and an integration test for /ingest.
9. **No production deploy.** Compose is dev-only. Production = Vercel (web) + Fly.io/Render (api) + the same hosted Supabase.
10. **Scanned PDFs unsupported.** pypdf only extracts text from text PDFs. Image-only PDFs would need OCR (P4 if a user actually needs it).
11. **No memory of chat history.** Each question is a one-shot — no multi-turn conversation. P3 adds conversation memory (and the agent loop that benefits from it).
12. **Notes & URLs are embed-on-save; doc nodes are embed-on-upload.** Two paths. The right unification is a single `/nodes/{id}/reindex` endpoint that picks the right source per type. P2.

Knowing these honestly is the difference between "I shipped P1" and "I shipped P1 and can see the next ten things to do."

---

## 4. Tech stack (with the one-liner reason for each)

| Layer | Tech | Why this and not X |
|---|---|---|
| Frontend framework | Next.js 15 App Router | Server components + middleware; smoothest SSR auth |
| Frontend lang | TypeScript | Catches RAG-shape bugs at the boundary |
| Styling | Tailwind 3 | Zero CSS file fights; consistent design tokens |
| Client state | Zustand | Smallest store with hooks; no Redux boilerplate |
| Graph rendering | @xyflow/react (React Flow v12) | Mature, accessible, declarative |
| Backend framework | FastAPI | Async, typed, OpenAPI for free |
| Backend lang | Python 3.12 | AI ecosystem lives here |
| Token tokenizer | tiktoken | Same family as the embedding/chat models |
| PDF extraction | pypdf | Pure Python, no system deps |
| LLM provider | OpenAI (text-embedding-3-small, gpt-4o-mini) | Cheapest defaults that work well; swappable |
| Vector DB | pgvector (HNSW) | Co-located with metadata; free; works to 10M+ |
| Auth + DB + Storage | Supabase (hosted) | One service, three needs; ships RLS for free |
| Dev infra | Docker Compose | Two-line file; reproducible |
| JWT verifier | python-jose | Supports HS256 + JWKS shapes we need |

---

## 5. What ships in P2/P3/P4

Don't memorize details — know the *shape* of each phase.

- **P2 — smarter retrieval.** Recursive chunking. Hybrid (vector + BM25). Reranker. Semantic edges job. Redis queue for ingestion.
- **P3 — agents.** Tool-using agents (`search_memory`, `read_node`, `link_nodes`). Reflection loops. Web-research agent that grows the graph.
- **P4 — observability + evals.** OpenTelemetry tracing. Golden eval set. recall@k, faithfulness. Hallucination check. Memory compression.

---

## 6. Interview prep

### 6.1 The elevator pitch (90 seconds)

> *"Mem Palace is a visual AI memory system I built to learn production RAG. Knowledge lives as nodes on a canvas — notes, uploaded docs, URLs — and a user can chat with their own memory. Architecture is two services: a Next.js app for the UI and auth, a FastAPI app for the AI work (chunking, embedding, retrieval, streaming). Data lives in Supabase: Postgres with pgvector for vectors next to metadata, plus Auth and Storage. Auth uses JWT with RLS at the database layer, so a bug in my API can't leak data across users."*
>
> *"The retrieval path is: embed the question with OpenAI, top-k cosine search via a pgvector HNSW index, prompt the model with numbered context, stream the response over SSE with a live trace that shows each pipeline stage. I designed the SSE channel as an extensible event log — today it carries stage/sources/token events, in the next phase it'll carry tool_call and reflection events when I add real agents. The UI is the same; only the events get richer."*
>
> *"The honest tradeoffs: no eval harness yet, no reranker, ingestion is synchronous and will move behind a queue, and the 'agent' today is a fixed pipeline — I deliberately didn't fake agent traces. P2 is smarter retrieval. P3 is real agents. P4 is observability and evals."*

### 6.2 Likely questions (with strong answers)

**Q: Why pgvector instead of Pinecone/Weaviate?**
*A: Co-location. Vectors live next to their metadata in Postgres — JOINs work, one backup, one auth model, one source of truth. pgvector with HNSW handles ~10M vectors comfortably; that's two orders of magnitude past my current scale. I'd move to a dedicated vector DB when I measure latency-at-recall pain, not before.*

**Q: How does your retrieval handle "out of context" questions?**
*A: The system prompt instructs the model to say "I don't have that in your memory yet" if the context doesn't answer the question. The top-k is always returned in the sources event, so the UI can show that retrieval ran but returned low-similarity hits. P4 will add a similarity threshold (drop top-k if max < ~0.3) and post-hoc faithfulness checks (LLM-as-judge verifying the answer is grounded in cited chunks).*

**Q: Walk me through what happens when a user signs up.**
*A: Auth UI calls supabase.auth.signUp(). GoTrue creates a row in auth.users. My on_auth_user_created trigger fires — it's SECURITY DEFINER with a pinned search_path, schema-qualified table names. It inserts a row into public.profiles and a default workspace into public.workspaces. JWT is issued and cookie-set. Browser navigates to /graph. The trigger has to be careful about search_path — without setting it explicitly, Supabase's hardened SECURITY DEFINER defaults fail to resolve unqualified table names.*

**Q: How do you protect user data with two backend services?**
*A: Defense in depth across three layers. Browser holds a session cookie. Next.js middleware refreshes the cookie and gates protected routes. FastAPI verifies the JWT — supports both HS256 with the legacy secret and asymmetric ES256/EdDSA via JWKS, picked from the token's alg header. Then Postgres RLS enforces row visibility per auth.uid(). I use a "two-key" pattern: user-context client (anon key + user JWT) for normal operations so RLS applies; service-role client only for explicit system jobs that need to bypass RLS, like the bulk chunks insert during ingestion.*

**Q: Why split into two services?**
*A: AI tooling — embeddings, chunking, evals, agent frameworks — lives in Python. UI and SSR auth are more idiomatic in Node. Splitting also lets each tier scale independently: a flood of chat traffic won't pressure the embedding pipeline and vice versa. The boundary is JWT-on-Authorization-header, which forces a clean trust contract.*

**Q: What's a chunk size of 500 tokens? Why not 200 or 2000?**
*A: 500 is a baseline. Small enough that 5-10 chunks fit comfortably in a chat completion's context budget alongside a system prompt and question. Big enough to usually contain a complete idea — a paragraph or two of prose. Below ~200 tokens you lose enough surrounding context that retrieval starts returning fragments. Above ~1000 tokens you waste context budget on irrelevant neighbors. The 50-token overlap (~10%) protects against sentences cut at boundaries. Real answer: I'd measure recall@k on a golden Q→A set before tuning further.*

**Q: How does streaming work? Why SSE and not WebSockets?**
*A: SSE is one-way HTTP streaming. Server sends `event: <name>\ndata: <json>\n\n` frames. Browser consumes via EventSource or, as I do, by reading fetch().body as a ReadableStream and splitting on double newline. It fits LLM token output exactly — one-way, no upgrade handshake, plays through HTTP proxies. WebSockets would be overkill; I'd reach for them only when I need full duplex, like collaborative cursors. Browser's EventSource is GET-only, which is why I used fetch — I need POST with an Authorization header.*

**Q: How would you add tools / make this a real agent?**
*A: My SSE channel is already shaped for it. Today I emit stage / sources / token / done events. For agents I'd add tool_call and tool_result events on the same channel. The agent loop is straightforward: model returns a tool call, the API executes it (search_memory, read_node, link_nodes), result goes back to the model, loop until the model emits a final answer. The UI's trace component already supports an arbitrary list of events; rendering tool calls is the same component with more event types. Reflection is just one more event type — the model critiques its own draft before committing.*

**Q: What's the biggest weakness of your current retrieval?**
*A: No reranking. Top-k by raw cosine similarity is decent but loses ~10-20% recall vs. retrieving more candidates and reranking with a cross-encoder. It's also pure vector — no keyword matching. A question that mentions an exact codename or acronym can miss because vectors smooth over the symbol. P2 adds hybrid retrieval — RRF fusion of pgvector results with Postgres tsvector full-text — plus an LLM reranker on the top-N to choose top-K.*

**Q: How does the trigger handle SECURITY DEFINER correctly?**
*A: Modern Supabase hardens SECURITY DEFINER functions by giving them an empty search_path. So a function that does `INSERT INTO profiles ...` (unqualified) fails because the planner can't resolve `profiles`. The fix is to (1) explicitly set search_path on the function and (2) schema-qualify every table reference. I learned this when my first signup failed with "Database error saving new user" — the actual Postgres error in the auth logs was a relation-not-found. The hardening also closes a real CVE-class issue: a malicious user with CREATE on another schema could otherwise shadow your tables.*

**Q: How did you handle Supabase's switch to asymmetric JWT keys?**
*A: My verifier reads the JWT header first to find the alg field. HS256 → verify against SUPABASE_JWT_SECRET. ES256 / EdDSA / RS256 → fetch JWKS from the project's well-known endpoint, look up the key by kid, verify with the public key. I cache JWKS in-process and on unknown kid I evict + retry once to absorb key rotation. This handles both legacy and modern Supabase projects with the same code path. The pattern is identical at Auth0 / Cognito / Okta — public key discovery via JWKS is the standard.*

### 6.3 Tradeoff questions (where you should sound principled)

**"What would you change about this architecture if you had more time?"**

Be honest, ordered by impact:
1. **Move ingestion off the request path.** Redis queue with arq. 1-5s blocks are fine for one user; fall apart with concurrency.
2. **Add evals.** Without recall@k and faithfulness, I'm flying blind on retrieval quality.
3. **Hybrid retrieval + reranker.** Cheapest high-impact win on retrieval quality.
4. **Tests around chunking and retrieval.** They're the riskiest pieces to silently regress.

**"Where do you think this would break first under load?"**

Two predictions:
1. **Embedding rate limits** if many users sign up and upload at once — OpenAI's tier limits would throttle. The queue plus exponential backoff fixes it.
2. **HNSW index quality** as it grows past ~1M chunks — the recall might quietly degrade. Need to monitor and consider IVFFlat or a dedicated vector DB.

---

## 7. What to do with this guide

- **Right after writing**: read top to bottom once. Note the soundbites that feel awkward — rephrase them in your own voice.
- **Day before an interview**: re-read sections 6.1 and 6.2.
- **During refactors**: come back to section 3 (caveats) to remember why something exists in its current half-finished state.
- **Six months from now when you're maintaining this**: read section 2.3 (the three flows) before debugging anything.

You shipped a working production-shape RAG system in one session. The interview story writes itself if you can speak to **why** as fluently as **what**.
