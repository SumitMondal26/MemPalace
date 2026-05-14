# Decisions Log

Architecture Decision Records, kept lightweight. Each entry: **Context** (why we're choosing now), **Decision** (what we picked), **Consequence** (what we accept). Add a new entry rather than rewriting history.

---

## ADR-001 — Hosted Supabase, not self-hosted

**Date:** 2026-05-12

**Context.** Initial sketch ran a full self-hosted Supabase stack via Docker (~9 containers). For a single-developer dev environment optimizing for learning AI engineering, that's a lot of infra to manage for no AI insight.

**Decision.** Use the hosted Supabase free tier in dev. The repo holds only migrations and an optional seed file. `docker-compose.yml` runs only `web` + `api`.

**Consequence.**
- Pro: `docker compose up --build` starts in ~60s, two containers, dead-simple onboarding.
- Pro: Closer to what most AI startups actually ship; honest interview story.
- Con: Internet required in dev.
- Con: Free tier has rate limits and a 7-day inactivity pause — fine for solo dev.

---

## ADR-002 — Two services: Next.js + FastAPI

**Date:** 2026-05-12

**Context.** Could have shipped a single Node app and called OpenAI from there. But the AI ecosystem (embedding libs, evals, agent frameworks, observability SDKs) is Python-first.

**Decision.** Two app containers. Next.js owns UI, SSR, and auth cookies; FastAPI owns AI workloads.

**Consequence.**
- Pro: Idiomatic libraries on each side; clear scaling axes.
- Pro: Forces a JWT boundary that exercises real production patterns.
- Con: Two deploys, two Dockerfiles, two dependency surfaces.

---

## ADR-003 — pgvector inside Supabase, not a dedicated vector DB

**Date:** 2026-05-12

**Context.** Pinecone / Weaviate / Qdrant are all viable. They're optimized for the vector workload.

**Decision.** Use pgvector. Vectors live in the same Postgres as their metadata.

**Consequence.**
- Pro: Transactional consistency, hybrid queries (JOINs), one backup story, free.
- Pro: Performs well to ~10M vectors with HNSW. Far past P1 needs.
- Con: When we measure pain (latency at recall, index build times), we'll need to migrate. Bridge built in P4 if needed.

---

## ADR-004 — RLS for tenancy, JWT-forwarded from FastAPI

**Date:** 2026-05-12

**Context.** With a separate API tier, naïvely we'd use service-role for everything and do tenancy checks in app code. That puts the entire security model in our handler logic.

**Decision.** FastAPI verifies the user's JWT, then makes Supabase calls *with that JWT* (anon key + Authorization header) so `auth.uid()` resolves in RLS. Service role is reserved for explicit background work.

**Consequence.**
- Pro: Defense in depth. Bug in an API handler can't leak across workspaces because Postgres refuses the query.
- Pro: RLS policies in `0001_init.sql` are the security spec — readable in one place.
- Con: Slightly more plumbing in the FastAPI Supabase client per-request.

---

## ADR-005 — SSE for chat streaming

**Date:** 2026-05-12

**Context.** Chat needs token streaming. WebSockets, SSE, and long-polling all work.

**Decision.** Server-Sent Events.

**Consequence.**
- Pro: One-way streaming matches LLM token output exactly. Works through HTTP proxies, no upgrade handshake.
- Pro: Trivial to consume in the browser (`EventSource`); trivial to emit from FastAPI (`StreamingResponse`).
- Con: One-way only — when we add agent ↔ user back-and-forth in P3 we may revisit.

---

## ADR-017 — LLM query rewriting on multi-turn /chat (P2 closer)

**Date:** 2026-05-15

**Context.** ADR-014 introduced multi-turn chat by sending the last 6 messages to the LLM at generation time. The *answerer* could resolve "she", "it", "the second one" from history. But the *retriever* could not — `embed_query` was called on the user's latest message in isolation. So the chat would *answer* a follow-up like "how old is she?" correctly only when retrieval got lucky and surfaced the right node anyway. The expanded golden set (commit `5a23188`) baked this asymmetry into measurable cases (`vague-partner`, `vague-her-age`).

**Decision.** Add a dedicated query-rewriting step before embedding. One LLM call (gpt-4o-mini, temperature 0, `response_format=json_object`, max 120 tokens) takes the latest question + last 4 turns and returns `{"query": "..."}` — a standalone search query naming the entities. We embed *that* instead. The user-visible question still goes into the prompt verbatim (rewriter steers retrieval, not generation). New SSE event `rewrite` exposes the rewritten query so the chat panel + /insights can show users exactly what got searched.

Gated on `query_rewrite_enabled` in settings (default on) AND presence of history — single-turn chats skip the call entirely (~$0.0001 + ~500ms saved). Eval harness gets a parallel `EVAL_QUERY_REWRITE=1` toggle so we can A/B exactly the same way we A/B'd graph-augmented retrieval.

**Measured (20-case golden set, graph-augmented retrieval, k_max=10):**

| metric    | rewrite OFF | rewrite ON |
|-----------|-------------|------------|
| recall@1  | 80.00%      | **85.00%** |
| recall@3  | 95.00%      | 95.00%     |
| recall@5  | 100%        | 100%       |
| MRR       | 0.885       | **0.910**  |

`vague-partner` flipped rank 2 → 1 (similarity 0.234 → 0.552, big jump because "partner" is now bridged to the actual name). `vague-her-age` was lucky-rank-1 already (template collision with "is X years old") but its similarity climbed 0.438 → 0.770. No other case moved — rewriter correctly returned single-turn questions unchanged.

**Consequence.**
- Pro: Closes the multi-turn weakness with a measurable +5pp recall@1 / +0.025 MRR.
- Pro: Cleanly observable — `rewrite` SSE event + `original_question` / `rewritten_question` columns in chat_logs let /insights show exactly what got searched vs what the user typed.
- Pro: No changes to retrieval SQL, no schema migration on chunks, no re-ingest. Pure orchestration layer change.
- Pro: Skipped on single-turn — zero added cost or latency for the dominant case.
- Con: Adds ~500-1500ms latency on multi-turn turns (one LLM round-trip). Could be parallelized with embed-of-original as a hedge if we ever care.
- Con: Adds ~$0.0001 per multi-turn chat. Negligible for personal use; would matter at high RPS — gate behind a heuristic (pronoun detector?) at scale.
- Con: Rewriter is itself an LLM and can hallucinate. Mitigations: temperature 0, JSON-mode, max_tokens 120, fall back to original on any parse failure. We never let it block the chat path.

**Future work.** When hybrid retrieval lands, rewriting becomes more important because BM25 actively rewards the entity name being literally present in the query.

---

## ADR-016 — Unified add-memory flow: one button + dropdown + sidebar draft

**Date:** 2026-05-15

**Context.** Original P1 surfaced three distinct buttons in the header: `+ note`, `+ doc`, `+ url`. Each instantly created an empty node and opened the sidebar so the user could fill in title + content. UX problems with this:
- Three buttons crowded the header next to Sign out + Insights link.
- "Empty node now exists in DB; user might walk away leaving cruft."
- For URL, no dedicated URL field — user had to remember to paste a URL into the content textarea.
- After Save, user had to manually click "✨ Auto-connect" to wire the new node into the graph. Easy to forget.

A first iteration (commit `7e598b0` era) tried a modal for type-specific creation. That added a third visual layer (canvas + sidebar + modal) — too much.

**Decision.** Single "+ Add memory ▸" button with a dropdown of three types. Picking a type doesn't create a node; instead it sets `draftType` in the Zustand store, which causes the sidebar to render a type-aware DraftForm in the same slot it normally uses for editing. Submit creates the node, transitions the sidebar to edit-mode, then chains: embed → auto-connect → refresh edges, all in the background.

The store state has `selectedNodeId` and `draftType` as mutually exclusive (selecting clears the draft, drafting clears the selection). Sidebar visibility (slide-in transform) keys on `selectedNodeId || draftType`.

**Consequence.**
- Pro: One button instead of three. Header less cluttered.
- Pro: No empty nodes in DB if the user backs out — node only exists after Save.
- Pro: URL gets a dedicated input field; doc shows a hint about file upload coming after creation.
- Pro: Auto-connect chain means new memories are immediately wired into the graph without an extra click.
- Pro: No modal layer — uses the same sidebar slot the user already learned for editing.
- Pro: Mutually-exclusive store slices model the UX correctly (you can't draft AND edit simultaneously).
- Con: Form fields lose state if user picks a different type mid-draft (acceptable — uncommon flow).
- Con: A failure in the auto-connect chain is silent (logged to console, not surfaced to user). Pre-P3, acceptable; with agents we'd want UI feedback.

---

## ADR-015 — AI observability: chat_logs table + /insights page

**Date:** 2026-05-15

**Context.** Until now, debugging the chat pipeline meant tailing FastAPI logs and squinting at console output. No way to ask "what was the most expensive request today?" or "why does this answer look wrong — what was actually in the prompt?" Real LLM apps have observability. We needed our own.

**Decision.** Two pieces:

1. **Prompt visibility in the chat panel** (Phase 1). The /chat handler emits a new SSE event `event: prompt` with the full messages array sent to OpenAI, the model, and the temperature. The ChatPanel captures it and shows an expandable "view raw prompt" panel under each assistant message. Lets the user (and us) see exactly what the LLM saw.

2. **chat_logs table + /insights page** (Phase 2). A new Supabase table records one row per chat turn with: question, answer, full prompt array, cited node IDs, model + embed model, retrieval strategy + filter ratios, similarity range, history size, per-stage timings (embed/search/LLM), token counts (embed/prompt/completion via OpenAI's `stream_options.include_usage`), and computed $ cost from a per-model price table. RLS is workspace-scoped so users only see their own. A new `/insights` page renders aggregate cards (total cost, avg/p95 latency, empty-context rate), a per-stage timing breakdown bar, a list of recent requests with cost/latency/tokens at a glance, and a drill-down panel showing every captured field plus the raw prompt for the selected row.

**Why build it ourselves rather than adopt Langfuse / Phoenix.** Learning value. The shape of an observability tool is something every AI engineer should understand from the inside. Migration to OpenTelemetry → external tool is straightforward later (~half a session swap; the chat_logs row maps almost 1:1 to OTel spans). Until then, we own the data, the schema, and the queries.

**Consequence.**
- Pro: Every chat turn now produces a complete debugging record. Bugs that used to be vibes ("this answer looks wrong") become reproducible — the prompt is right there.
- Pro: Token + cost tracking from day one. Bill awareness is built into the project, not a future surprise.
- Pro: Per-stage timing data accumulates over time → eventually drives data-driven optimization (e.g., "search is 60% of avg latency, focus there").
- Pro: Privacy is workspace-scoped via RLS. No cross-user leak.
- Con: One extra DB write per chat turn. Async, fire-and-forget, can't block the user response — wrapped in try/except.
- Con: Storage grows unbounded. Add 30-day retention via a scheduled job in P3.
- Con: Cost calculation hardcodes prices; needs maintenance as OpenAI rates change. Worth it for awareness, not worth a complex billing-API integration.
- Con: The prompt event surfaces user-content to the browser. Fine for personal-use Mem Palace; for multi-tenant prod gate behind a debug flag.

**Path:** P3 adds time-series charts (cost-over-time, latency histograms) and "top cited nodes" analytics. P3+ swaps to OpenTelemetry-via-Langfuse if multi-tenant ops become necessary.

---

## ADR-014 — Multi-turn chat: client sends history, server caps it

**Date:** 2026-05-14

**Context.** Each chat turn was previously independent. Users couldn't ask follow-ups like *"what about her age?"* or *"how does it work?"* because the model had no prior context — every turn started cold. Real chat UX needs at minimum a few turns of memory.

**Decision.** The browser maintains the full conversation in component state (already does — `messages`). On each new question, it snapshots the prior turns (filter empty placeholders), sends them as a `history` field on the `/chat` request body. The API caps the history to the last 6 messages (`HISTORY_MAX_MESSAGES`) at the boundary so a runaway client can't blow the context window. The LLM service appends them to the messages array between the system prompt and the current user turn.

The system prompt was updated to explain history handling: prior assistant replies are NOT authoritative for the current turn — only the fresh Context is. This prevents the model from drifting into "I said X earlier so I should keep saying X" when current retrieval contradicts a prior claim.

**Consequence.**
- Pro: Natural follow-ups work — pronouns, "what about", "the second one", etc.
- Pro: Conversation memory is local-only (lives in component state, dies on reload). No server storage, no sync. Simplest possible.
- Pro: Hard cap at the API prevents pathological usage.
- Con: History resets on page reload. P3+ would persist conversations to DB if users want persistent threads.
- Con: Retrieval still fires on the literal current question only. A query like "how many heads?" might miss the right chunks because vector similarity to the bare phrase is weak. P3 upgrade: rewrite the query using prior context before embedding ("how many heads does multi-head attention use?" rewritten from "how many heads?" + prior turn about MHA).
- Con: Cost grows per turn (~each turn re-sends prior content). Capped at 6 messages keeps it bounded.

**Path:** P3 adds query rewriting (LLM call before retrieval) when conversation context is non-trivial. P3+ persists conversations if multi-device or share-thread is needed.

---

## ADR-013 — Auto-connect v2: best-pair-chunk + kNN per node

**Date:** 2026-05-14

**Context.** ADR-010 shipped auto-connect with two design choices that turned out to be wrong as the corpus grew:
1. **Mean-of-chunks** as a node's representative embedding. For long docs (the 23-chunk Transformer paper), the mean lives in a generic "AI paper" zone and matches nothing specifically. Result: `book` was permanently isolated from any short note even when the topic clearly overlapped (e.g., `"sumit likes reading books related to AI"` scored only 0.315 against `book`).
2. **Single global threshold** (0.4) for whether to create an edge. Different node-pair categories live on different similarity scales — short-note vs short-note peaks ~0.6, short-note vs long-doc-mean peaks ~0.4, related entities in different sentence templates peak ~0.4. No single threshold serves all of them.

The user-facing failure mode: after each new note, *some* obvious connections didn't form. The temptation was to keep lowering the threshold. The realization: tuning a threshold forever can't fix a model that's wrong-shaped. Real systems use multiple signals and relative (not absolute) ranking.

**Decision.** Migration `0005_rebuild_semantic_edges_v2.sql` replaces the SQL function with two architectural shifts in one rewrite:

1. **Best-pair-chunk similarity:** for every node pair (A, B), compute `max(1 - (chunk_a.embedding <=> chunk_b.embedding))` over all chunk pairs across A and B. The max — not the mean. A long doc connects to a note as long as *one* chunk matches strongly.
2. **kNN per node (no threshold):** for each node, rank all potential partners by best-pair-chunk score, take top-K (default K=3). An edge forms if a node is in either party's top-K (either-direction inclusion). No absolute cutoff.

`weight` on the edge stores the actual similarity so the canvas can fade weak edges without filtering them out.

**Consequence.**
- Pro: No more threshold tuning. Every node always gets ~K visible connections.
- Pro: Long docs become first-class graph citizens. The `book` problem dissolves.
- Pro: Adapts naturally to corpus growth. A node in a dense cluster connects to its tightest local neighbors; a node in a sparse area connects to its 3 nearest, even if absolute similarity is low.
- Pro: Backward-compatible API surface (function name + endpoint unchanged; old `sim_threshold` param accepted-but-ignored).
- Con: Quadratic in chunk count per workspace. For ~30 chunks (us): ~900 chunk-pair comparisons, instant. For ~10K chunks: ~100M comparisons — getting heavy. P3+ scale needs batched/approximate computation OR an HNSW-backed sweep.
- Con: A node forced to have 3 connections might form weak edges in a small workspace. Acceptable because edge weight visually distinguishes strong from weak. With more memory, weak edges naturally get displaced.
- Con: kNN doesn't enforce minimum quality. A "dense visualization with no real signal" is possible. Mitigated by edge weight rendering; future work: optionally cap edges where similarity < some floor (configurable, but no longer the central knob).

**Path:** evals re-run with new edge structure to measure if retrieval lifts (or regresses) on the existing 8 cases. Add new golden cases that specifically exercise long-doc connections.

---

## ADR-012 — Graph-augmented retrieval (1-hop neighborhood expansion)

**Date:** 2026-05-14

**Context.** Up until now, the graph (manual + semantic edges) was rendered in the 3D canvas but never used by RAG retrieval. `match_chunks` did pure vector search. Edges contributed nothing to answer quality — they were decoration. With the evals harness in place we can now measure whether bringing the graph into retrieval helps.

**Decision.** A new SQL function `match_chunks_with_neighbors(query_embedding, match_count, neighbor_count)` does two things in one round-trip:
1. Pure vector top-k (same as `match_chunks`) — the "seed" chunks.
2. 1-hop graph expansion: find nodes connected by any edge (manual or semantic, undirected) to a seed node, fetch the top-N most-relevant chunks from each, and union with the seeds.

Returned rows carry a `source` column ('direct' or 'neighbor') so the UI / trace can distinguish vector hits from graph expansions. `/chat` uses this function with `neighbor_count=1` by default; the existing similarity-threshold filter applies uniformly to both sources to avoid weak neighbor chunks polluting context.

The eval script supports both strategies via `EVAL_STRATEGY` env var, so we can A/B compare baseline vs graph-augmented on the same golden set.

**Consequence.**
- Pro: The graph now contributes to RAG instead of being decoration. The project's central thesis ("memory as a graph") becomes operationally true, not just visual.
- Pro: All in SQL — one round-trip; pgvector + CTEs do the heavy lifting; no Python pairwise loops.
- Pro: Source labels enable interview story ("vector hit vs graph expansion") and future UI work (different chip styles per source).
- Pro: A/B-measurable from day one via the eval strategy switch.
- Con: Query is more expensive than `match_chunks` (extra JOINs against edges + window function over neighbor chunks). For small workspaces, negligible. For workspaces with thousands of nodes + dense semantic graphs, may need an upper bound on neighbor candidates per seed.
- Con: Treats all edges as equally weighted in expansion. Manual edges (user intent) and semantic edges of varying strength all bring in 1-hop neighbors. P3 work: weight expansion by edge weight + kind.
- Con: Currently only 1 hop. Multi-hop reasoning (sumit → sumit's gf → her age) needs P3 agent loop, not pure SQL.

---

## ADR-011 — Retrieval evals: standalone Python script + JSON golden set

**Date:** 2026-05-14

**Context.** P1 + semantic edges shipped with no way to measure retrieval quality. Every threshold and chunking decision was a guess validated by eyeballing the chat panel. The same pattern is about to repeat as we plan graph-augmented retrieval and best-pair-chunk — without numbers, we can't tell if changes help, regress, or do nothing.

**Decision.** A standalone script `apps/api/eval/run_evals.py` reads a hand-curated JSON golden set (`golden.json`) of (question, expected_node_titles) cases. For each case it embeds the question with the production OpenAI model, calls the production `match_chunks` RPC against the production Supabase, maps returned chunks to node titles, and records the first rank where an expected node appears. Aggregates: recall@1, recall@3, recall@5, recall@10, MRR. Failure list at the bottom for failed cases. `make evals` is the entry point.

The script uses the service-role key (bypasses RLS) and direct stdlib `urllib`/`json` — no python deps required, no FastAPI start needed.

**Consequence.**
- Pro: Every future retrieval change becomes measurable. Built once, used forever.
- Pro: Failure list reveals patterns (false friends, low-confidence matches, wrong-node-high-sim) without needing tracing infrastructure.
- Pro: Zero-dependency stdlib script means anyone can clone the repo, fill `.env`, and `make evals`.
- Con: Tests retrieval in isolation — auth, RLS, FastAPI middleware, and full /chat composition aren't measured. Those need their own tests later.
- Con: No faithfulness or answer-quality metrics yet (LLM-as-judge is P3 work). recall@k tells you "did we find the right chunk?", not "did the model use it correctly."
- Con: Golden set quality is human-bottlenecked. Bad cases produce misleading numbers. Convention: cases must come from real user phrasings, not engineered to pass.

**Path:** P2 expands cases as more memory is added; P3 adds LLM-judge faithfulness; P4 wires evals into CI to gate retrieval changes.

---

## ADR-010 — Semantic edges via pairwise cosine on node-mean embeddings

**Date:** 2026-05-14

**Context.** The thesis of Mem Palace is "memory as a graph that organizes itself." P1 shipped with only manual edges — the user clicks-and-drags to connect nodes. Until that vision shows up visually, the project is a 3D React Flow with chat bolted on. We need agent-like graph behavior, starting somewhere.

**Decision.** A SQL function `rebuild_semantic_edges(ws_id, threshold)` computes the mean chunk-embedding per node (`avg(c.embedding)` from pgvector 0.7+), pairwise cosine similarity over all node pairs in the workspace (`1 - (a.embedding <=> b.embedding)`), and inserts edges with `kind='semantic'` and `weight=similarity` for pairs above threshold (default 0.65). The endpoint `POST /workspaces/{id}/rebuild-edges` triggers it; a "✨ Auto-connect" UI button in the canvas calls the endpoint and refetches edges. Idempotent — re-runs delete previous semantic edges first.

**Consequence.**
- Pro: Agent-shaped behavior with zero ML novelty — pure linear algebra over what we already have.
- Pro: All in SQL — one round-trip, scales to thousands of nodes via pgvector ops, no Python numpy needed.
- Pro: Cleanly separated from manual edges (different `kind`); they coexist, manual stays untouched.
- Pro: The 3D canvas already styles semantic edges with animated purple particles, so the visual upgrade is free.
- Con: Mean-of-chunks per node is a coarse representation. A long doc whose mean lies in "general AI paper" space won't connect to a specific question about attention even if a single chunk perfectly matches. P2 upgrade: "best-pair-chunk" similarity (max over chunk-pair cartesian product) or a small LLM-judge for borderline pairs.
- Con: Threshold 0.65 is a guess. Without evals (yet), we can't say if it produces too many spurious edges or misses real ones. To be tuned when the eval harness lands.
- Con: Runs synchronously over the request (~50-500ms for small workspaces). Past ~1000 nodes, move behind a Redis queue in P2.

---

## ADR-009 — 3D force-directed canvas (react-force-graph-3d) over 2D React Flow

**Date:** 2026-05-13

**Context.** The "memory palace" framing wants a brain-like, organic visual. P2/P3 will explode the edge count via semantic-similarity sweeps and agent-driven linking; manual 2D layouts (React Flow) collapse under dense graphs unless we author positions, which contradicts the agent-driven future. We need a layout that scales with edge density.

**Decision.** Replace the React Flow canvas with `react-force-graph-3d` (three.js under the hood). Nodes are colored emissive spheres on a dark background; semantic edges animate flowing particles to distinguish them from manual edges. Layout is emergent from edges; we do not persist positions.

**Consequence.**
- Pro: Aesthetic matches the framing — clusters become visually obvious as edges densify, exactly what P2/P3 need.
- Pro: Force simulation scales to thousands of edges where 2D layouts thrash.
- Pro: The same SSE/agent extension story applies — when P3 adds semantic edges, they appear as animated purple particles and the simulation pulls related nodes into spatial clusters.
- Con: +~600 KB three.js bundle. Acceptable for a portfolio demo; would be addressed with code-splitting / route-level chunking for prod.
- Con: We give up manual drag-to-position UX. Re-enabled in P2 with explicit "pin" feature using the still-present `nodes.x/y/z` columns.
- Con: Mobile/touch UX is harder than 2D. Out of scope for P1.

---

## ADR-008 — Every node's content is embedded, not just uploaded files

**Date:** 2026-05-13

**Context.** The first cut of ingestion only embedded files uploaded via `/ingest`. User-typed notes lived in `nodes.content` and were invisible to RAG. Result: asking "what is my name?" when you had a note titled `name` with content `my name is sumit` returned "I don't have that in your memory yet." That undermines the whole memory-palace framing — your own thoughts should be retrievable, not just the documents you cite.

**Decision.** A new endpoint `POST /nodes/{id}/embed` rebuilds the chunk set for a node from its current `content` field. The Sidebar fires this fire-and-forget after every save on `note` and `url` nodes. For `doc` nodes, `/ingest` already populated chunks from the file; we don't double-embed.

**Consequence.**
- Pro: Every memory becomes searchable — notes, URLs, docs, all surfaced through the same `match_chunks` RPC. Mental model is uniform.
- Pro: Idempotent and self-healing — empty content cleans up old chunks, edited content replaces them.
- Con: Two API calls per save (DB update + embed) instead of one. Latency on save still feels instant because we don't await the embed.
- Con: P1 has a small race window — two rapid saves can produce duplicate chunks. Lives until P2 moves embedding behind a per-node Redis queue.

---

## ADR-007 — JWT verification supports both HS256 and JWKS

**Date:** 2026-05-12

**Context.** Supabase used to sign all JWTs with HS256 + a shared `SUPABASE_JWT_SECRET`. Newer projects default to asymmetric signing keys (ES256 / EdDSA / RS256) for user tokens, with the public half exposed via `<SUPABASE_URL>/auth/v1/.well-known/jwks.json`. The static `anon` / `service_role` keys remain HS256-signed against the legacy secret. We need both to work.

**Decision.** `deps.get_claims` reads the token's `alg` header. HS256 → verify against the legacy secret. ES256/EdDSA/RS256 → fetch JWKS, look up the key by `kid`, verify with the public key. JWKS is cached in-process; on unknown `kid` we evict + refetch once to absorb rotation.

**Consequence.**
- Pro: Works with any Supabase project, old or new. Works through key rotation.
- Pro: Matches the production pattern at Auth0 / Cognito / Okta / Clerk — transferable mental model.
- Con: Slightly more code in `deps.py` and one extra dependency hit on cold start.

---

## ADR-006 — No LangChain in P1 (and P2)

**Date:** 2026-05-12

**Context.** LangChain offers prebuilt retrieval / agent abstractions. It also hides the loops, which defeats the learning goal of this project.

**Decision.** Hand-write the retrieval loop, prompt assembly, and (in P3) agent loop. Adopt selectively in P3/P4 only if a specific piece pays for itself.

**Consequence.**
- Pro: Mental model is yours, not borrowed. Every interview question about "how does retrieval work" has a real answer.
- Con: More code in `apps/api/app/services/`. That's the point.
