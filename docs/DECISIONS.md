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

## ADR-020 — Hand-written agent loop (no framework) — P3.1

**Date:** 2026-05-15

**Context.** P3 introduces tool-using agents — the model can call `search_memory`, `read_node`, `list_clusters`, `read_cluster_members` and reason in steps. Two real choices for how to build the loop: pull in LangChain (or LangGraph, or OpenAI Assistants API), or hand-roll on top of OpenAI's raw `tools` parameter.

ADR-006 already chose "no LangChain through P3" for learning reasons. This ADR re-confirms that for the agent specifically and documents the implementation shape.

**Decision.** Hand-written loop in `services/agent.py`, ~30 lines of real logic:

```
messages = [system, ...history, user_question]
for iter in range(MAX_ITERATIONS):
    resp = await openai.chat.completions.create(messages, tools=TOOL_SPECS)
    msg = resp.choices[0].message
    if not msg.tool_calls:
        yield AgentFinalAnswer(msg.content); break
    messages.append(msg)
    for call in msg.tool_calls:
        result = await dispatch_tool(call.name, parsed_args, ctx)
        yield AgentToolCall(...) ; yield AgentToolResult(...)
        messages.append({"role": "tool", "tool_call_id": call.id, "content": ...})
```

Three guards baked in: `MAX_ITERATIONS=5` (cost ceiling), per-tool `try/except` returning `ok=False` (errors land in-band so the LLM can recover), `max_tokens=800` per LLM call (per-turn output cap).

The loop is async-iterable so the router yields SSE events as they happen — `tool_call` / `tool_result` / `final` / `done`. Without this, the user stares at "Thinking..." for 10s while three tool calls run. With it, the trace UI fills in real-time.

**Tools shipped (all read-only):**
- `search_memory(query, k=5)` — wraps the existing graph-augmented retrieval. Returns top-k with node id, title, similarity, preview.
- `read_node(node_id)` — full title + content + cluster label.
- `list_clusters()` — all clusters with member counts.
- `read_cluster_members(cluster_id)` — node ids + titles for one cluster.

Write tools (create_summary_node, link_nodes) are deferred to P3.3 — the audit/confirmation/undo story is heavier than P3.1's scope.

**Endpoint shape.** New `POST /agent` rather than a flag on `/chat`. Two reasons: cleaner separation in observability (`is_agent=true` column lets /insights split metrics), and the SSE protocol differs (agent emits tool_call/tool_result events that /chat doesn't have). Frontend toggle in ChatPanel routes between them.

**Observability.** Migration `0012` adds `is_agent`, `agent_iterations`, `agent_tool_calls` (jsonb), `agent_hit_iter_cap` to `chat_logs`. /insights gets agent rows for free; tool_calls jsonb gives full per-step replay.

**Why no framework.**
- The agent loop is the highest-value thing to understand in the entire project for interview purposes. Frameworks abstract exactly the part you want to internalize.
- LangChain has had ~3 major rewrites in 18 months. Code from 2024 doesn't run on current versions. Hand-rolled code is stable across OpenAI SDK minor bumps.
- We can drop in framework code later if integration pain (research agent web fetchers, etc.) outweighs the cost. The decision is reversible per-feature.

**Iteration cap behavior.** When the agent hits `MAX_ITERATIONS` without producing a final answer (no tool calls), we issue ONE more LLM call WITHOUT tools available — forces the model to summarize what it found instead of looping. The `agent_hit_iter_cap` flag lets /insights surface this case and the UI shows an amber chip rather than the normal violet one.

**Consequence.**
- Pro: ~200-line agent that does what 1000+ lines of framework code does, with full visibility into the message-history shape, the tool dispatch flow, and the cost guards.
- Pro: Errors are in-band — a tool dispatch exception becomes a tool message the LLM reads. The LLM can decide to retry with different args or move on. We don't hard-code recovery logic.
- Pro: Streaming SSE events for every loop step — UI sees the reasoning unfold in real time.
- Pro: Adding a new tool is two changes (one schema entry, one dispatch function). No decorators, no registration ceremony.
- Con: 3× cost vs `/chat` for a typical 3-iteration agent question (each iteration's input tokens include all prior tool results). Surfaced in the chip + /insights so users can see what they're paying for.
- Con: 5-15s latency typical. Necessary for multi-step reasoning; mitigated by the trace UI showing progress.
- Con: Token budget on an active conversation can balloon — a 5-iteration agent over a 6-message history with 4 tool calls each iteration approaches 4-8k input tokens. Manageable today; would need conversation summarization at higher load.
- Con: Final answer is delivered as one `final` event (not token-streamed) on the agent path. /chat still streams tokens. Chose this for protocol simplicity; can revisit if UX feels too "blank then dump."

**Future work (P3.2-3.5).**
- 3.2: reflection loop — judge model critiques final answer, agent retries if low-grounded.
- 3.3: write tools (create_summary_node, link_nodes) — gated behind a confirmation UX + audit table.
- 3.4: memory agent — orchestrates the read-tools to propose summaries autonomously, runs as a button-triggered job (later, scheduled).
- 3.5: research agent — adds web-fetch tools, expands the graph from external sources. Most ambitious, most cost-aware.

---

## ADR-019 — Topic clustering: scalable substrate (Phase 1 — sklearn + members-hash)

**Date:** 2026-05-15

**Context.** ADR-018-era topic clustering shipped with pure-Python k-means + a hand-rolled silhouette helper. Fine for this user's 14-node corpus, but the math doesn't scale: pure-Python k-means is O(n × k × dim × iters) without SIMD, and the silhouette is O(n²). Rough projections at the time: n=10k → ~30 minutes for k-means alone, n=1k → silhouette dominates the runtime. Naming, by contrast, is per-cluster — scales with K, not N — so it was already fine.

The user pushed back ("we have to think a scalable version, not cost / bottleneck"), correctly. The pure-Python implementation was a "ship today" choice that needed to be promoted before it became load-bearing on bigger workspaces.

**Decision.** Replace the math substrate (only). Naming pipeline unchanged.

1. **`scikit-learn.cluster.MiniBatchKMeans`** in place of pure-Python k-means. MiniBatchKMeans trades ~2% quality for 10-100× speed at scale; standard for production-grade topic modeling. `n_init=10` random restarts; `random_state=42` for determinism across runs.

2. **`sklearn.metrics.silhouette_score(sample_size=...)`** in place of the hand-rolled O(n²) silhouette. When n>100 we sub-sample 1000 points for the score — preserves the *ranking* of K candidates (the only thing we use silhouette for) while bounding computation to O(n × sample_size).

3. **`numpy` arrays end-to-end** for the embedding matrix (was list-of-lists). Changes the inner loop from interpreted Python to BLAS.

4. **`clusters.members_hash` column + label reuse.** Compute `sha256(sorted(member_ids))` per cluster. Before naming, look up the previous run's `(hash → label)` map; matching hashes reuse the previous label and skip the LLM call. In steady state most clusters between two recompute runs have identical membership — this saves ~$0.0001 × N unchanged clusters per recompute.

5. **Adds 2 deps to API**: `numpy==1.26.4`, `scikit-learn==1.5.2`. ~80MB to the container image. Acceptable for a service that does any serious numerical work.

**Explicitly NOT in this ADR (deferred):**
- Tier 1 incremental clustering on node create (single-row nearest-centroid lookup)
- Tier 2 nightly background recompute via Redis + arq
- Tier 3 async/queued endpoint with SSE progress updates
- HDBSCAN, hierarchical clustering, or any K=auto algorithm beyond silhouette
- Quality fix to assignment errors (the BTS-in-Books case) — that's a separate Stage-1 problem, not Stage-2 (math) which this ADR scopes

**Measured (n=14, today's user):**

| metric | before (pure-Py) | after (sklearn) | notes |
|---|---|---|---|
| k-means time | ~80ms | ~50ms | n too small to show real lift |
| silhouette time | ~10ms | ~5ms | sub-sample inactive at n=14 |
| naming calls | k | k on first run, ≤k on re-runs | reuse only kicks in when membership stable |

**Projected at n=10k:** k-means ~5s, silhouette ~1s, naming dominated by reuse rate. From "minutes" today to "single-digit seconds" — the actual unlock.

**Consequence.**
- Pro: No more O(n²) silhouette death at moderate scale.
- Pro: Naming cost in steady state drops to "0 calls if the corpus didn't materially change" — the right shape.
- Pro: members_hash is also useful for future cache invalidation (e.g. "cluster sidebar that lists members" can compare against a known-good hash).
- Pro: Standard tools — anyone reading this who has done ML knows MiniBatchKMeans + silhouette_score on sight.
- Con: +80MB to the API container image. First boot pulls them.
- Con: scikit-learn import is non-trivial (~1s cold start). One-time; runtime queries fast.
- Con: The hash comparison hardcodes an "exact membership match" definition. A cluster that gained 1 of 50 nodes still gets re-named. A future refinement could be Jaccard-similarity threshold, but that's overengineering until we have multi-cluster diff cases.
- Con: Phase 1 doesn't solve the assignment-quality problem (BTS-song-in-Books case). That's not a math bug; it's an embedding-ambiguity issue that wants either a different algorithm (LLM-as-clusterer) or a different signal (chunk content into the assignment, not just node-mean embeddings). Logged as future work.

**Future work.**
- **Phase 2 — incremental + background**: Tier 1 nearest-centroid on node create + Tier 2 nightly recompute via Redis+arq. Defers the recompute cost off the request path entirely.
- **Phase 3 — algorithmic upgrades**: HDBSCAN for variable cluster sizes, or LLM-as-clusterer for the "agentic" assignment step. ADR'd separately when load justifies.

---

## ADR-018 — LLM-as-judge reranker (P2 closer #2)

**Date:** 2026-05-15

**Context.** Caught live in /insights: a single-turn question *"how old is he ?"* returned `[1] sumit's age @ 0.45` and `[2] Eijjuu's age @ 0.44` — a 1-percentage-point similarity gap. The LLM picked `[2]` and confidently answered "Eijjuu is 25 years old." Two failures stacked:
1. **Vector retrieval can't see pronoun gender.** "How old is he?" is geometrically near any "how old is X" template chunk, regardless of gender of the subject.
2. **The downstream LLM gets two near-tied chunks and picks one.** With no signal that one is more relevant than the other, the choice is essentially arbitrary.

Query rewriting (ADR-017) couldn't help: there was no history to disambiguate "he". This was a precision problem at the candidate-list level, not a recall problem.

**Decision.** Add an LLM-as-judge reranker between vector retrieval and prompt assembly. New service [apps/api/app/services/reranker.py](apps/api/app/services/reranker.py). Pipeline becomes:

```
embed → search_chunks_with_neighbors (over-fetch 2× k_max)
      → threshold filter (sim ≥ 0.4)
      → reranker: send top-N (max 8) + question to gpt-4o-mini, JSON mode,
        get {"ranked": [<indices>]}, reorder, take top-K
      → prompt builder
```

Auto-skip when:
- Fewer than 2 candidates (nothing to rerank).
- Top similarity > 0.10 above second (clear winner — don't pay).
- Parse failure or API error (fall back to original order).

Defensive: every failure path returns the original order trimmed to top_k. The reranker, like the rewriter, can never break /chat.

**Why LLM-as-judge over a cross-encoder.** Cross-encoders (`bge-reranker-base`, etc.) are faster per call (~50ms) and free per call after the model download (~400MB). But they need a Python ML dep + model download in the API container, and the team doesn't have a measured need for the latency yet. LLM-as-judge ships in zero infra changes for ~$0.0001/turn. Easy to swap to a cross-encoder later if cost or latency demands.

**Why JSON mode + temperature 0 + max_tokens 80.** Same pattern as the rewriter — bound the output shape, the cost ceiling, and the determinism. The judge's job is a transformation, not a creative task.

**Measured (21-case golden set, graph-augmented retrieval, k_max=10, query rewriting ON):**

| metric    | rerank OFF | rerank ON |
|-----------|------------|-----------|
| recall@1  | 85.71%     | **95.24%** (+9.5pp) |
| recall@3  | 95.24%     | **100.00%** |
| recall@5  | 100%       | 100%      |
| MRR       | 0.914      | **0.976** (+0.062) |

Three cases flipped to rank 1:
- `personal-relationship-japane` ("kenojo"): rank 5 → 1
- `girlfriend-birthday`: rank 2 → 1
- `single-turn-pronoun-he`: rank 1 stayed but the reranker explicitly chose `sumit's age` over `Eijjuu's age`, which was the live failure mode in the UI.

Only `personal-gym` still misses (rank 2). Hybrid retrieval (next P2 item) targets exactly that case (literal "PPL split" in chunk).

**Cost & latency.** ~$0.0001 per chat turn that runs the rerank. ~500-2500ms added latency on those turns (most of the variance comes from prompt size — top-8 candidates with 400-char previews each = ~1000 input tokens). The skip-on-clear-winner gate means simple lookups don't pay either.

**Consequence.**
- Pro: Closes the live "how old is he?" failure plus several near-tie cases the team didn't know about (kenojo at rank 5 was eye-opening).
- Pro: +9.5pp recall@1 / +0.062 MRR is the largest single-PR retrieval lift in the project's history. Makes the "evals don't lie" story concrete in interviews.
- Pro: Reranker can be flipped off via `RERANK_ENABLED=false` env var if cost ever matters more than precision.
- Pro: Logs are observable — `rerank_was_reranked`, `rerank_skip_reason`, `rerank_ms`, cost split out so /insights can show "this answer was rescued by rerank."
- Con: +1 LLM round-trip on every chat turn that doesn't auto-skip. ~500-2500ms added latency. Acceptable for personal use; would justify a cross-encoder swap at scale.
- Con: Reranker prompt is 1000-1500 tokens. At enterprise scale this dominates the cost envelope; budget before turning on for every workspace.
- Con: We over-fetch 2× from retrieval to give the reranker more candidates. Doubles the SQL work per chat. Negligible at current scale; would matter past 1M chunks.

**Future work.** When hybrid retrieval lands, the reranker becomes more important — BM25 surfaces a different *kind* of candidate (exact-keyword) that vector misses, and the reranker has to decide between heterogeneous candidates. The pipeline is set up for it.

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
