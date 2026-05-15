# Progress Log

Chronological record of what shipped, in what commit, and what was learned. Read top-to-bottom to see the project's evolution. Newest at the bottom.

This is **not** a changelog (those are version-anchored). This is a **learning log** — every entry has a "What I learned" section so future-me can recover context.

---

## 2026-05-12 — `30195ff` — bootstrap P1

**Shipped:**
- Two-service Docker Compose (Next.js + FastAPI), hosted Supabase
- DB schema + RLS + signup trigger + match_chunks RPC
- Auth end-to-end (email+password, JWT verify in FastAPI)
- Graph canvas (initially React Flow 2D), node CRUD, manual edges
- Upload pipeline → chunk → embed → pgvector
- RAG chat with SSE streaming
- 7 ADRs documenting the load-bearing choices

**What I learned:**
- **Hosted Supabase removes ~10 containers of infra.** Every dev minute saved is a minute spent on AI work. ADR-001 captures the tradeoff.
- **Two-service split (Node + Python)** is the standard pattern at AI startups, not because it's fashionable but because the AI ecosystem (embeddings, evals, agents) lives in Python while UI/SSR is most idiomatic in Node.
- **RLS at the DB layer is defense in depth.** A bug in FastAPI can't leak data because Postgres refuses the query.
- **Two-key pattern (anon + service-role)** isolates user-context work from system-context work. Mix them deliberately, never accidentally.
- **SECURITY DEFINER functions in modern Supabase need `set search_path` explicitly.** Hit this when signup failed with "Database error saving new user" — the trigger's unqualified `INSERT INTO profiles` couldn't resolve. Fix: schema-qualify table names and pin search_path.
- **Supabase moved to asymmetric JWT signing.** Legacy HS256 + shared secret still works for anon/service-role keys, but user tokens on new projects sign with ES256. Verifier needs to read `alg` from the token header and either verify against the secret OR fetch JWKS.

---

## 2026-05-12 — `be4b796` — 3D canvas + P1 study guide

**Shipped:**
- React Flow 2D → `react-force-graph-3d` (3D, force-directed, animated particles on semantic edges, glowing color-coded spheres)
- Floating particle field around the graph
- Sidebar slide-in from right on node-select
- Optional Maya-style floor grid
- ChatPanel moved to bottom-left
- "Clear chat" button
- ADR-009 capturing the 2D→3D pivot
- `docs/LEARNING.md` — the P1 study guide

**What I learned:**
- **react-force-graph-3d is the right tool** for organic graph layouts that scale with edge density. Force-directed simulation auto-clusters connected nodes spatially — exactly what you want when an agent is going to densify the graph.
- **Bundle cost (~600 KB three.js) is acceptable** for a portfolio demo. For prod you'd code-split.
- **Manual drag-to-position UX is incompatible with force-directed motion.** Force simulation always wants to re-arrange. Lost manual positioning, will return as "📌 Pin" feature in P2.
- **Continuous floating motion via `nodePositionUpdate`** — the per-frame React-Flow callback. After 1.5s warmup (let force sim settle), oscillate around locked base position with sinusoidal motion, write back to BOTH visual AND data position so edges follow spheres correctly.

---

## 2026-05-12 — `90eb119` — 3D click crash fix + relaxed grounding

**Shipped:**
- `enableNodeDrag={false}` workaround for 3d-force-graph DragControls bug (click→pointercancel→OrbitControls.onPointerUp crash)
- Relaxed system prompt (chat conversationally on out-of-context queries instead of robotic "I don't have that")
- `RELEVANCE_THRESHOLD = 0.4` filter on retrieved chunks so only confident matches enter the prompt
- Updated chat trace: shows "no strong matches — replying conversationally" when nothing passes threshold
- Source chips only render when chunks survive the threshold

**What I learned:**
- **Library bugs require pragmatic workarounds.** Disabling node-drag preserves all useful interaction (orbit, zoom, click-to-select) and eliminates a recurring console error that surfaced as a Next dev toast on every click. Document why you disabled the feature so future-you knows it was deliberate.
- **Strict grounding produces robotic UX.** "I don't have that in your memory yet" is technically correct when retrieval is weak, but it's the wrong response to "hello". Threshold filter + relaxed prompt gives both: grounded answers when retrieval is confident, conversational replies when it isn't.
- **The relevance threshold is a UX decision, not just a quality knob.** It controls whether the user sees citations or chat.

---

## 2026-05-13 — `a7b71ac` — semantic edges + edge-follows-sphere fix

**Shipped:**
- `rebuild_semantic_edges` SQL function: pairwise cosine over node-mean embeddings (`AVG(vector)` + cross-join + `<=>` cosine), idempotent, RLS-respecting
- `POST /workspaces/{id}/rebuild-edges` API endpoint
- "✨ Auto-connect" button in canvas with status chip
- `setEdges` Zustand action for bulk edge updates
- ADR-010 capturing the design + tradeoffs
- 3D canvas fix: `nodePositionUpdate` now writes oscillating position to `node.x/y/z` so edges follow sphere centers (was: edges attached to ghost points where data position lived while spheres drifted)
- Viewport-relative auto-fit padding (15% of min dimension)

**What I learned:**
- **All in SQL is the right pattern for graph computations.** pgvector's `AVG(vector)` aggregate + `<=>` operator means pairwise cosine is one round-trip, no bandwidth, no Python numpy. Scales to thousands of nodes.
- **Embedding similarity has a ceiling on short text.** First default of 0.65 produced 0 edges. Probed actual scores — clearly-related short notes peak at ~0.6. Lowered to 0.5, then 0.4 after a second iteration. **Threshold tuning is empirical, not theoretical.**
- **The "false friends" problem.** Two unrelated short sentences with the same template ("X is N years old" + "Y is M years old") score higher than two related sentences with different templates. Embedding similarity weighs surface form alongside meaning, inseparably.
- **Edges-vs-spheres misalignment was a feedback loop.** Edges follow `node.x/y/z` (sim data position). Spheres rendered at `node.x + sin*8` (visual). They diverged. Fix: dual-write — mutate `node.x/y/z` to the visual position each frame, with a 1.5s warmup that lets the sim place nodes first.

---

## 2026-05-14 — `cfce78a` — evals harness

**Shipped:**
- `apps/api/eval/golden.json` — 8 hand-curated cases over real data
- `apps/api/eval/run_evals.py` — pure-stdlib Python runner (no `pip install` needed)
- `make evals` target
- `docs/EVALS.md` — methodology
- ADR-011 capturing the design

**Baseline numbers** (recorded so future changes are comparable):
- recall@1: 75%
- recall@3, @5, @10: 100%
- MRR: 0.875

**What I learned:**
- **Evals are the foundational skill in RAG engineering.** Without them, every threshold/chunking/prompt decision is religion. With them, every decision is engineering. **This should have been built first.**
- **recall@k = "did the right answer show up in top k?"** Counted as a percentage over all cases. Saturates at 100% on small corpora — once it does, switch to MRR for ongoing signal.
- **MRR (Mean Reciprocal Rank) = average of `1/rank`.** Penalizes ranking the right answer low. 0.875 means the average right-answer position is ~1.14 (mostly rank 1, occasionally rank 2).
- **The two cases that don't rank 1 matched our predictions exactly:** template collisions ("how old am I" loses to "Eijjuu is 25 years old") and low-resource vocabulary ("kenojo" romaji). The eval *quantified* what we'd debugged manually — anecdote → number.
- **Test the retrieval layer in isolation.** Eval uses service-role key, calls match_chunks directly, doesn't go through the full /chat path. We're measuring retrieval, not auth or LLM composition.

---

## 2026-05-14 — `eb620a9` — graph-augmented retrieval (1-hop expansion)

**Shipped:**
- `match_chunks_with_neighbors` SQL function: vector top-k + 1-hop graph expansion in one round-trip; returns rows with `source` label ('direct' or 'neighbor')
- `search_chunks_with_neighbors` Python wrapper
- `/chat` switched to graph-augmented retrieval by default
- Eval script `EVAL_STRATEGY` env var for A/B comparison
- `EVAL_K_MAX` env var for stress testing
- ADR-012 capturing the rationale + measured impact

**Measured impact:**
| Strategy | k_max | recall@5 | MRR |
|---|---|---|---|
| Baseline | 10 | 100% | 0.875 |
| Graph-augmented | 10 | 100% | 0.875 |
| Baseline | 1 | 75% | 0.750 |
| Graph-augmented | 1 | 100% | 0.875 |

**What I learned:**
- **The graph wasn't being used by RAG until this commit.** It rendered in the 3D canvas but the retrieval path ignored it. The project's central thesis ("memory as a graph") was decoration, not operational. This commit makes it operational.
- **The k=10 result (no measurable lift)** is informative, not disappointing. With only 5 nodes in the corpus and k=10, vector already returns chunks from every node. Graph expansion can't help when there's nothing left to add.
- **The k=1 stress test (75% → 100% recall@5)** simulates realistic production scale (many nodes + small k). Proves the mechanism: when vector picks a "false friend" as #1, graph expansion through the semantic edge cluster surfaces the right answer at rank 2.
- **The "noisy" semantic edges from auto-connect (false friends) actually save retrieval here.** Surface-form-similar nodes cluster together via auto-connect; that cluster contains the right answer when vector picks the wrong template. The "noise" turned out to be useful structure.
- **A/B switching is non-negotiable for retrieval changes.** Without `EVAL_STRATEGY`, comparing baseline vs new requires editing source. With it, every change is one env var away from being measured.

---

## 2026-05-14 — auto-connect v2 (best-pair-chunk + kNN per node)

**Shipped:**
- Migration `0005_rebuild_semantic_edges_v2.sql`: replaces the SQL function with best-pair-chunk similarity + kNN-per-node ranking. Same function name, same endpoint — backward-compatible.
- API endpoint param: `sim_threshold` → `k_neighbors` (default 3).
- ADR-013 capturing the architectural shift.
- RAG_NOTES.md updated to reflect the new approach.

**What I learned:**
- **Threshold tuning was a symptom, not a fix.** Each iteration (0.65 → 0.5 → 0.4) revealed a deeper problem: a single global threshold can't serve different node-pair categories that live on different similarity scales. Realizing this, then changing the *shape* of the decision (kNN per node, no global threshold), is more valuable than another tuning pass.
- **Mean-of-chunks for long docs is structural dilution.** The math is broken regardless of threshold. Best-pair-chunk (max over chunk pairs) makes long docs operational because *one* matching chunk is enough to forge a connection.
- **"Relative > absolute" is a recurring pattern in retrieval.** Similar to recall@k vs absolute distance — what matters is *order*, not raw scores. kNN inherits this principle.
- **Either-direction kNN is more inclusive than mutual-kNN.** Mutual gives stricter signal; either gives every node ~K connections (no orphans). For a memory graph where you want visual connectivity, either-direction is the right choice. Edge weight carries the strength signal so weak edges fade visually without being filtered.
- **Architectural courage > parameter tuning.** "We can't just keep lowering threshold" is the kind of insight that distinguishes an engineer from a tuner. The fix is changing the model, not the parameter.

---

## 2026-05-14 — `df4a078` — auto-connect v2.1: min-weight floor + weight-modulated edge viz

**Shipped:**
- Migration 0006: adds `min_weight` parameter (default 0.25) on `rebuild_semantic_edges`. Drops edges below the floor AFTER kNN selection.
- Frontend: edge `weight` is now in the `GLink` type. Edge width, opacity, and particle count modulate with weight.
- Particle color matches edge color (smooth gradient at this point, switched to discrete tiers in next commit).
- ADR-013 updated to capture the v2.1 refinement.

**What I learned:**
- **kNN guarantees connectivity but not quality.** Without a floor, every node gets K partners regardless of how weak. The floor is the absolute-minimum check that complements relative ranking.
- **Edge weight at the data layer + visualization at the view layer.** Don't filter weak edges out of the data — keep them and let the renderer fade them. Same idea as low-confidence search results in a different section.
- **The "false friends" problem returned at the floor level.** Looking at our edges: the `Eijuuu↔book` at 0.151 (forced by kNN) was matching on "people doing things together" surface pattern, not topic. The floor caught it cleanly.

---

## 2026-05-14 — `039be91` — discrete edge color tiers + legend + spaced-out force layout

**Shipped:**
- Tried gradient color (HSL purple shades) first — produced muddy mids hard to compare.
- Switched to **3 discrete color tiers**: slate (weak, < 0.40), cyan (medium, 0.40-0.50), amber (strong, ≥ 0.50). Distinct hues, easy to read at a glance.
- Edge tiers + color helper extracted to `apps/web/lib/edgeTiers.ts` so the legend in `GraphPageClient` reads from the same source as the canvas renderer.
- Legend appears in the top-right canvas controls under Auto-connect.
- Force-simulation tuning: bumped `linkForce.distance` to 80 and `chargeForce.strength` to -150. Edges now have visible length, nodes don't pile up.

**What I learned:**
- **Continuous gradients sound nice but distinct tiers read better.** Three colors mapping to three confidence buckets gave instant comprehension; HSL interpolation gave purple-purple-purple that all looked the same.
- **Single source of truth across UI components matters.** Putting `EDGE_TIERS` in a shared lib file means the legend swatches and the actual edge colors can never drift — change the constant, both update.
- **Next.js can be picky about non-component named exports from `"use client"` files.** First attempted to export the constant from GraphCanvas itself; got an "import not found" error. Moving to a plain `lib/` file fixed it. Worth knowing the boundary's quirks.
- **d3-force defaults are too cramped for our zoom level.** Defaults assume hundreds of nodes; we have a handful. Tuning is one-line per knob.

---

## 2026-05-14 — `cf41ec8` — multi-turn chat: client sends history, server caps to 6 messages

**Shipped:**
- `ChatRequest.history: list[ChatHistoryMessage]` field.
- API caps history at `HISTORY_MAX_MESSAGES = 6` (most-recent tail) at the boundary.
- `llm.stream_chat` accepts optional `history` param, splices prior turns between system prompt and current user-with-Context turn.
- `SYSTEM_PROMPT` updated: "prior assistant replies are NOT authoritative for current turn — only fresh Context is." Anti-drift insurance.
- ChatPanel snapshots messages BEFORE adding the new user/assistant pair, sends them as `history` in the request body.
- ADR-014 captures design + known weakness (retrieval still embeds the literal current question — vague follow-ups remain weak; query rewriting is the bridge to be built later).

**What I learned:**
- **History and RAG are complementary memory layers, not replacements.** Long-term = the graph + retrieval; short-term = conversation history; both stack into the same prompt. Each turn re-runs full retrieval on the current question.
- **The natural follow-up "how many heads?" exposes the limit.** Vector search of "how many heads?" alone is a weak signal. History helps the LLM understand the question, but retrieval doesn't see history. The fix is query rewriting (one LLM call to rewrite the vague question using prior context BEFORE embedding) — a P3-ish upgrade.
- **A hard cap at the API boundary protects you from runaway clients.** Without `HISTORY_MAX_MESSAGES = 6`, a buggy or malicious client could send 1000 prior messages and blow your context window + bill.

---

## 2026-05-15 — AI observability: prompt visibility + /insights page

**Shipped:**
- `event: prompt` SSE event from /chat carrying the full messages array sent to OpenAI. ChatPanel renders it as an expandable "view raw prompt" panel under each assistant message.
- New `chat_logs` table (migration 0007) — workspace-scoped via RLS. One row per turn with question, answer, full prompt, cited node IDs, model metadata, retrieval stats, per-stage timings, token counts, $ cost, status.
- /chat handler tracks `time.perf_counter()` per stage, captures token usage from OpenAI streaming (`stream_options.include_usage`), computes cost from a per-model price table, and writes the log row at the end (try/except so logging can never break user response).
- New `/insights` page: aggregate cards (cost, latency, empty-context rate), stage-timing breakdown bar, recent-requests list, drill-down panel showing every captured field including the raw prompt for the selected row.
- Header in `/graph` got an "Insights" link. Middleware extends auth gate to cover `/insights`.
- `done` SSE event now carries token counts + cost so ChatPanel can show a small "X+Y tokens · $0.00012" line under each turn.
- ADR-015 captures the design + rationale for building this in-house vs adopting Langfuse.

**What I learned:**
- **OpenAI streaming + token counts requires `stream_options.include_usage = true`.** Without it, the streaming response doesn't carry usage data and you have to estimate. With it, the final stream event carries `prompt_tokens` + `completion_tokens`. Same for embedding — the non-streaming response carries `usage.total_tokens` directly.
- **Cost lookup tables age fast.** Hardcoding OpenAI prices in code means the doc page goes stale every quarter. Acceptable for a personal-learning project; production teams either query OpenAI's pricing API or accept staleness with periodic updates.
- **Logging must never break the user response.** Wrapping the chat_logs INSERT in `try: except: pass` is the right call. A logging failure (e.g., DB temporarily unreachable) shouldn't surface as a chat error to the user.
- **Build observability in-house first, then graduate to a vendor.** Building a chat_logs schema + /insights page makes you understand exactly what Langfuse/Phoenix store and why. Migration to OTel later is straightforward (chat_logs row → OTel span). Adopting the vendor first means you never understand the abstraction.
- **The per-stage timing breakdown is gold.** When latency feels slow, you don't have to guess where — embed vs search vs LLM. Three numbers, sum to total. For our setup, LLM dominates (~60-70% of total).
- **"Privacy via RLS" composes naturally.** chat_logs reuses the same workspace_id-scoped policy as everything else. No new security model to design.

**Per-turn cost on our current usage** (gpt-4o-mini + text-embedding-3-small):
  - Embed: ~10 tokens × $0.02/1M = ~$0.0000002 (basically free)
  - Prompt: ~500-2000 tokens × $0.15/1M = ~$0.00007-0.0003
  - Completion: ~50-200 tokens × $0.60/1M = ~$0.00003-0.00012
  - **Total: ~$0.0001-0.0004 per chat turn** ≈ 1000-5000 turns per dollar.

---

## 2026-05-15 — `f34bd76` — unified add-memory flow

**Shipped:**
- Three "+ note / + doc / + url" header buttons replaced by one "+ Add memory ▸" with a dropdown of three types.
- Modal-based create flow scrapped. Instead, a type-aware DRAFT form renders *inside the sidebar* (slides in from right, same as edit mode).
- Note draft: title + content. URL draft: title + URL field + optional notes. Doc draft: title only; transitions to upload area after create.
- New `draftType: NodeType | null` slice in the Zustand store with `startDraft` / `cancelDraft`. Mutually exclusive with `selectedNodeId`.
- After creating a note/url with content, automatically chains: persist → embed → auto-connect → refetch edges. Zero manual clicks.
- `CreateNodeModal.tsx` deleted (no longer used).

**What I learned:**
- **Prefer one strong UI slot to many specialized ones.** Three buttons + a modal layer = visual noise + extra clicks. One button + dropdown + the existing sidebar slot = same functionality, less surface, more cohesive.
- **Mutually exclusive store slices model UX correctly.** "Drafting a new node" and "editing an existing node" are conceptually opposite — the user can't do both at once. Making `selectNode` clear `draftType` (and vice-versa) at the action level prevents the impossible "drafting AND editing" state from ever existing.
- **Auto-chained side effects feel magical when they're correct.** "Save → embed → auto-connect → refresh" all firing automatically after a single Save click is the difference between "this app is built well" and "I keep forgetting to click Auto-connect." The chain has to be reliable, though — wrap each step in try/catch so a partial failure doesn't break the next.

---

## 2026-05-15 — docs housekeeping pass #2

**Shipped:**
- ROADMAP updated to reflect P2 ~70% shipped, with the things-we-shipped-that-weren't-on-roadmap (observability, UI polish, unified add-flow) as their own group.
- 4 missing PROGRESS entries added (this entry, plus v2.1 / color tiers / multi-turn / unified add-flow / observability).
- ARCHITECTURE updated: multi-turn chat flow, observability flow, /insights mention, updated system diagram.
- README updated with new capabilities in "What works today" + new commands.
- LEARNING gets a new Part 3 covering today's concepts (multi-turn memory, AI observability, best-pair-chunk + kNN, min-weight floor, weight visualization, unified add-memory pattern).
- ADR-016 added for the unified add-memory flow design.

**What I learned:**
- **Docs drift faster than code, and the gap compounds.** The previous housekeeping pass at `adfea8b` covered ~half the project's history; only 4 commits later docs were stale again. The fix isn't docs-after-everything-ships but **a small entry per commit** — habit, not heroic effort.
- **Different docs serve different audiences AND different time horizons.** README = next-time-you-show-this; PROGRESS = next-time-you-debug-or-interview-prep; ROADMAP = next-time-you-decide-what-to-build; LEARNING = next-time-you-need-to-explain-it. The cost of any one being stale isn't the same.
- **Building observability (chat_logs + /insights) was originally P4 work.** I pulled it forward because the gym-question hallucination needed visibility to debug. Lesson: roadmaps are guides, not contracts. When a missing capability blocks understanding, build it now.

---

## 2026-05-14 — `adfea8b` — docs housekeeping

**Shipped:**
- ROADMAP.md updated to reflect P1 ✅ + P2 partial; added P1-polish sub-list
- ARCHITECTURE.md updated with current state (3D canvas, semantic edges flow, graph-augmented chat, eval pipeline, 8 invariants instead of 5)
- README.md rewritten with current capabilities, useful commands, recommended reading order
- `docs/PROGRESS.md` (this file) created — chronological learning log per commit
- `docs/LEARNING.md` extended with P2 concepts (recall@k/MRR, graph-RAG, false friends, eval-driven engineering loop)

**What I learned:**
- **Docs go stale faster than code.** A README that says "P1 in progress" weeks after P1 shipped becomes a lie that confuses future readers (including you). Periodic doc passes are part of the work, not optional.
- **Different docs serve different audiences.** README is for first-time visitors. ARCHITECTURE is for someone joining the project. DECISIONS is for someone changing the architecture. PROGRESS is for future-you reconstructing why things are the way they are. LEARNING is for the educational angle. Knowing the audience prevents one giant document that serves nobody.
- **A "progress log" is more useful than a changelog** for learning projects. Changelogs answer "what changed in v1.2?" Progress logs answer "what did I learn while building this?" The lesson > the diff.

---

## 2026-05-15 — `5a23188` + `28bbd7e` — golden set 8→20, query rewriting on multi-turn

**Shipped:**
- Golden eval set expanded 8 → 20 cases. New mix: more single-shot lookups, multi-node expansions (`cross-doc-ai-books`, `vague-partner`), long-doc paper retrievals (5 transformer-paper queries), and two pronoun-only "litmus" cases that exist specifically to measure query rewriting (`vague-partner`, `vague-her-age`). Cases that need it now carry an inline `history` field.
- `services/query_rewriter.py` — async, defensive (always falls back to original on parse/API failure), gpt-4o-mini + JSON mode + temp 0 + max 120 tokens. Skips the LLM call entirely when no history is present.
- `/chat` runs the rewriter as a new "Stage 0" gated on `settings.query_rewrite_enabled` AND `len(history) > 0`. Emits a new `rewrite` SSE event so the UI can show users exactly what got searched.
- Migration `0008` adds `original_question`, `rewritten_question`, `rewrite_ms`, `rewrite_tokens_in/out`, `rewrite_cost_usd` to chat_logs (additive only, all nullable).
- Eval harness gets `EVAL_QUERY_REWRITE=1` toggle that mirrors the production rewriter for cases carrying a `history` field.
- ADR-017 captures the design + the measured numbers.

**Measured (rewrite OFF → ON):**
- recall@1 80% → **85%** (vague-partner flipped rank 2 → 1)
- recall@3 95% → 95% (no churn)
- recall@5 100% → 100% (already saturated)
- MRR 0.885 → **0.910**
- vague-partner sim 0.234 → 0.552 (huge — entity is now in the query)
- vague-her-age sim 0.438 → 0.770 (was rank-1-by-luck via "is X years old" template, now rank-1-because-it-asks-the-right-thing)

**What I learned:**
- **The retriever and the generator had asymmetric context.** Multi-turn (ADR-014) gave the generator history but the retriever was still embedding the latest message in isolation. The fix isn't bigger embeddings or smarter SQL — it's recognizing the asymmetry and bridging it with one cheap LLM call. Architecture > parameters.
- **Designing the eval set BEFORE the feature is the productive order.** Adding `vague-partner` and `vague-her-age` to golden.json *before* writing the rewriter meant the win was measurable the moment code shipped. If I'd written the rewriter first I'd have hand-tested it and shrugged. Evals turn vibes into numbers.
- **Defensive LLM calls are different from defensive HTTP calls.** The rewriter has *three* failure modes that all need the same fallback (parse junk, API timeout, model returns wrong shape) — in every case, return the original question. Never let an auxiliary LLM call break the user's main flow.
- **JSON mode (`response_format={"type": "json_object"}`) is cheaper than parsing prose.** Combined with temperature 0 and a short max_tokens cap, the rewriter is bounded in cost AND output shape. This is how production LLM transformations look — not "ask nicely and pray."
- **Same-pipeline A/B is the cleanest experimental design.** The `EVAL_QUERY_REWRITE` env flag means the only thing that changes between the two runs is the one knob. Two numbers, one variable, story tells itself. Same pattern as `EVAL_STRATEGY` did for graph-augmented retrieval.

---

## 2026-05-15 — `e9c08fe` — LLM-as-judge reranker (P2 closer #2)

**Shipped:**
- `services/reranker.py` — async, LLM-as-judge over top-N candidates. JSON output mode, temp 0, max 80 tokens. Auto-skips on clear winner (sim gap > 0.10), <2 candidates, or parse failure. Returns `RerankResult` with movement map for /insights drill-down.
- `/chat` over-fetches 2× body.k from retrieval, threshold-filters, reranks → top-K. New `rerank` SSE event for the UI. Stage label "Reranking candidates by relevance" added to the trace.
- Migration `0009` adds `rerank_was_reranked / rerank_skip_reason / rerank_ms / rerank_tokens_in/out / rerank_cost_usd` to chat_logs.
- Eval harness: `EVAL_RERANK=1` flag mirrors production reranker. Banner shows rerank state.
- New golden case `single-turn-pronoun-he` captures the live UI failure (chunks at sim 0.45 vs 0.44).
- Docs: ADR-018, ARCHITECTURE invariants #13/#14, RAG_NOTES section, ROADMAP P2 → ~90%.

**Measured (rewrite-only → rewrite+rerank):**
- recall@1 85.71% → **95.24%** (+9.5pp)
- recall@3 95.24% → **100.00%**
- recall@5 100% → 100% (already saturated)
- MRR 0.914 → **0.976** (+0.062)

Cases that moved to rank 1: `personal-relationship-japane` ("kenojo") was rank 5, `girlfriend-birthday` was rank 2. The `single-turn-pronoun-he` retrieval was already rank 1 in the eval — the live UI bug was the LLM picking [2] over [1] in a near-tie. The reranker's job there is to widen the gap by promoting the right chunk explicitly, which is what eval ranks can't show but /insights can.

**What I learned:**
- **Recall and precision are different problems with different fixes.** Vector retrieval (recall) gets the right chunks *somewhere* in the candidate list. Reranker (precision) makes sure the *right one is at the top*. The first three layers of the stack (vector + graph + threshold) all optimize recall. The reranker is the first precision-side fix in the project.
- **LLM-as-judge is a real production pattern, not a placeholder for "the real reranker."** Cross-encoders are faster per call but need ML deps + model download + weight management. For sub-1k QPS, an LLM call in the chat pipeline is fine and the dev velocity tradeoff is huge.
- **Cost guards matter as much as the feature itself.** The skip-on-clear-winner gate (sim gap > 0.10) means simple lookups don't pay for the rerank. Without it the reranker would burn $0.0001/turn on questions where vector retrieval already had the right answer locked in. Always design the skip case alongside the active case.
- **Eval can't see all the wins.** The rerank fixed the live UI failure (LLM picking the wrong near-tie), but the eval would have shown that case as already-rank-1. Two separate quality dimensions: "is the right chunk in the candidate list?" (recall) and "does the LLM cite the right chunk?" (faithfulness). The latter needs an LLM-as-judge eval — that's a P4 item.
- **Over-fetch is the unsung enabler of every reranker.** Without it (`fetch_k = body.k * 2 if rerank_enabled else body.k`), the reranker would just be reordering the same 5 chunks vector retrieval was going to send anyway. The win comes from giving it candidates 6-10 to potentially promote.

---

## 2026-05-15 — `6632d3f` — graph UI: search, hover details, clusters

**Shipped:**
- `NodeSearch` component — floating top-left search input. Live substring filter on titles, ↑/↓/Enter/Esc keyboard nav, "/" anywhere on the page focuses it. Picking a match selects the node AND flies the camera to it (~700ms ease).
- Richer `nodeLabel` tooltip on hover — type, title, cluster name, content preview (truncated to 220 chars), all in one styled card.
- New `linkLabel` tooltip on edges — kind badge (semantic/manual), weight as a percentage, source ↔ target node titles.
- `lib/clusters.ts` — connected-components clustering on the weight-thresholded (≥0.4) semantic-edge subgraph. Deterministic IDs (smallest member id wins → stable across renders), 8-color palette, cluster label heuristic (most-common-first-word + member count, e.g. *"sumit (4)"*).
- Node color now: selected (white) > cluster color (when ≥2-member cluster) > type color (singleton fallback).
- Cluster legend in the canvas controls column — only renders when ≥1 cluster exists, shows color dot + label + member count per cluster.

**What I learned:**
- **Use the structure you already paid for before computing new structure.** I almost shipped k-means + LLM-named topics for the cluster feature. That would have meant a new endpoint, new embeddings round-trip, OpenAI cost per recompute, and a place to persist cluster names. But the auto-connect pipeline (best-pair-chunk + kNN + min-weight floor) had ALREADY computed a similarity graph. Connected components on that graph reads the structure for free. Cheaper, faster, deterministic, and good enough that we can upgrade to k-means later if useful.
- **Threshold-then-cluster, not cluster-then-threshold.** Dropping weak edges *before* the BFS was load-bearing. With weak edges included, a single 0.27-weight chance match between two unrelated topics merged them into one giant blob — exactly the false-friend problem ADR-013 already solved at the *edge* layer. Reusing the same threshold (0.40, the medium-tier floor) keeps the cross-UI story consistent.
- **Camera fly-to needs the post-sim node position, not the data position.** `data.nodes[i]` carries `x/y/z` mutated in place by the d3 sim (and by our per-frame oscillation). Reading those — not the original DB `nodes.x/y` — is what makes the camera land on the node where the user actually sees it.
- **Singletons fall back gracefully.** Nodes that don't make it into any size-≥2 cluster keep their type color so the canvas doesn't go drab. Default-degrade is more important than the new-feature-everywhere instinct.
- **Tooltips are an anti-clicking superpower.** I was about to fetch chunk counts on every hover (server roundtrip). Then realized hover is the *fast* affordance — if you want full details you click. Hover should answer "what is this?" in <0.1s; the sidebar answers "everything about this." Two tiers, two response budgets. Keeping hover lightweight (no DB calls) preserves the snappiness.

---

## 2026-05-15 — `6632d3f` — agentic topic clustering + Phase 1 scaling

**Shipped:**
- `services/clustering.py` — k-means on node-mean embeddings + per-cluster LLM naming. Two stages, deliberately split: deterministic math for grouping, one LLM call per cluster for the human-readable label. Defensive parsing with "Topic N" fallback.
- Migration `0010_clusters` — dedicated `clusters` table (id / workspace_id / label / color / created_at), `nodes.cluster_id` FK with `on delete set null`, plus `workspace_node_embeddings(ws_id)` SQL function returning `(node_id, AVG(embedding))` for cheap server-side mean computation.
- `POST /workspaces/{id}/recompute-clusters` endpoint — destructive on the workspace's clusters: pulls embeddings + titles, runs the service, deletes old clusters (cascades cluster_id → null), inserts new ones, updates each node's cluster_id.
- Frontend: 🏷 Recompute topics button next to Auto-connect, status chip with k_chosen + silhouette + cost, server-side load of clusters on first paint, `dbClusters` slice in the Zustand store, `applyClusters` action.
- Cluster focus interaction — clicking a cluster row in the legend dims all non-member nodes/edges to near-bg colors. Selection still wins over dim. Re-click or "clear" to reset.
- **Phase 1 scaling refactor** (ADR-019): replaced pure-Python k-means with `sklearn.cluster.MiniBatchKMeans` + `sklearn.metrics.silhouette_score(sample_size=...)`. Added numpy + scikit-learn (~80MB to API image). Migration `0011` adds `clusters.members_hash` (sha256 of sorted member ids); the endpoint reuses the previous label when a cluster's hash matches an old one — saves the LLM cost on unchanged clusters in steady state.
- `lib/clusters.ts` grows a `buildClusterIndexFromDb` adapter so the canvas treats DB-persisted (LLM-named) clusters and connected-components fallback identically. Renderer doesn't know which source produced the grouping.

**Measured (n=14):**
- First recompute: 4-5 LLM naming calls, ~$0.0005, 3-5s.
- Repeat recompute on unchanged corpus: 0 LLM calls, $0, status chip reads "5 named, 5 reused" via members_hash.
- After adding 1 node: K-means renegotiates partitions, most clusters get re-named (low reuse rate when membership shifts).

**What I learned:**
- **K-means + LLM-naming is the productive split for "agentic" topic clustering.** Letting the LLM do both jobs (group AND label) is ~10× more expensive and doesn't scale past ~100 nodes (token limit). Letting an algorithm do the math and the LLM do the writing is the clean separation: math gives precision, LLM gives readability. People sometimes call this a "small LLM workflow" or "agentic", honestly it's just well-chosen division of labor.
- **`members_hash` is a cheap reuse mechanism that pays off in steady state.** When the user re-clicks Recompute without adding nodes, every cluster's hash matches → 0 LLM calls. The optimization is invisible until you watch the status chip ("5 named, 5 reused") — that's the point.
- **K-means assigns by embedding proximity, not meaning.** Caught live with the user's data: a "BTS songs" note ended up in a Books cluster because both project as "personal preferences" in vector space. Fix isn't more math; it's letting the LLM read the actual content and reason. Logged for follow-up (LLM-as-clusterer).
- **Don't hardcode user-specific data into infrastructure prompts.** I tried fixing a pronoun ambiguity by baking "Sumit/Raj/Carlos lean male" into the rerank prompt. User correctly called it out — that's product-specific data leaking into shared infrastructure code. A second user named Maria would get worse retrieval. Reverted. The right fix is workspace-scoped identity (deferred).
- **Premature optimization wastes runway.** I almost shipped Redis+arq + nightly background jobs for clustering on a 14-node corpus. The user pushed back: "we have to think a scalable version, not cost / bottleneck." Right reframe — design the architecture, ship the implementation that fits today, document the scale-up path. ADR-019 captures the tiered architecture (online / periodic / on-demand) without prematurely building tiers we don't need yet.

---

## 2026-05-15 — `6632d3f` — URL ingestion cleanup + inline media previews

**Shipped:**
- `services/chunking.prepare_for_embedding(text)` — strips http(s) URLs from text before chunking. Called from both `/nodes/{id}/embed` and `/ingest`. The visible `nodes.content` keeps the URL (for display + the new MediaPreview); the embedded text doesn't include it.
- `MediaPreview` component (frontend) — renders inline media in the sidebar based on node type:
  - **doc + image mime** → `<img>` with signed-URL src
  - **doc + application/pdf** → inline `<iframe>` (~360px tall, scroll inside)
  - **url node** → detect platform from hostname:
    - YouTube (`youtube.com`, `youtu.be`, `/shorts/`) → `https://www.youtube.com/embed/{id}` iframe
    - Vimeo → `https://player.vimeo.com/video/{id}` iframe
    - URL ending in image extension → `<img>`
    - URL ending in `.pdf` → iframe
    - everything else → clean "Open ↗" link card (no iframe — most sites X-Frame-Options:deny)
- `db.createUploadSignedUrl(path, 3600s)` helper — mints a 1-hour signed URL from Supabase storage so the browser can render private uploads inline.
- Sidebar mounts MediaPreview at the top of the form area, above Title.

**What I learned:**
- **The URL noise hypothesis was partially wrong.** I'd predicted that the YouTube URL in the BTS-song node would drown out the "Eijuuu likes this BTS song" caption in the embedding. After clustering re-ran with one new node, k-means correctly placed it next to the existing BTS note anyway — the prose signal was stronger than I thought. Stripping URLs is still the right call (cheap, more honest about what's semantically meaningful), but the "fix" wasn't the rescue I framed it as.
- **Hover ≠ sidebar = different latency budgets.** I almost put media previews in hover tooltips. That would have meant: signed-URL roundtrip on every mouse pass, video autoplay flickers, perf death. Hover should answer "what is this?" in <0.1s with text only. Sidebar absorbs heavier work because it only fires on intentional click. Two response budgets, two surfaces.
- **Most third-party sites can't be iframe-embedded.** X-Frame-Options:deny / CSP frame-ancestors:none. Trying to embed arbitrary URLs produces a broken iframe placeholder that's worse than a clean link card. Detect the platforms you can embed (YouTube, Vimeo, your own files), fall back to a respectful link for everything else. The "real preview of arbitrary pages" feature requires server-side Open Graph fetching — different scope.
- **Signed URLs are private-storage's read primitive.** RLS protects the *row*, signed URLs protect the *object*. 1h expiry is the right default — long enough that a sidebar reading session works, short enough that a leaked link is useless.

---

## 2026-05-15 — `b05351f` — P3.1: bare agent loop with read-only tools

**Shipped:**
- `services/tools.py` (new) — OpenAI tool schemas + pure-function dispatch for `search_memory`, `read_node`, `list_clusters`, `read_cluster_members`. All read-only; write tools deferred to P3.3. Result size caps everywhere (preview chars, list rows) so the LLM context stays bounded.
- `services/agent.py` (new) — hand-written loop, ~200 lines real code. OpenAI `tools` parameter, `MAX_ITERATIONS=5`, per-tool `try/except` returning `ok=False` so errors land in-band. Async-iterable so the router can yield SSE events as they happen.
- `POST /agent` endpoint (new) — separate from `/chat`. SSE events: `tool_call`, `tool_result`, `final`, `done`. Writes a chat_logs row with `is_agent=true` + full tool_calls jsonb. Iteration-cap path: forces one no-tools summary LLM call instead of looping.
- Migration `0012_chat_logs_agent` — adds is_agent / agent_iterations / agent_tool_calls jsonb / agent_hit_iter_cap.
- ChatPanel — agent-mode checkbox (routes between /chat and /agent), `AgentTrace` sub-component renders each tool call as a collapsible row with icon + args + duration. Click to expand the JSON args / result preview. Violet "agent · N iterations" chip on the answer; amber "hit iteration cap" chip when capped.
- ADR-020 documents the design + the reason to stay framework-free through P3.

**What I learned:**
- **The agent loop is just `while`.** I had been imagining frameworks needed for tool-using agents. The actual loop is 30 lines of real logic: call the LLM with tools, dispatch any tool_calls, append results to messages, repeat. Everything else (LangChain, LangGraph, Assistants API) is convenience on top of this primitive. Reading the loop end-to-end is what teaches you what these frameworks are *doing*.
- **Errors belong in the message history, not the call stack.** A tool that raises Python exceptions kills the whole agent run. A tool that returns `{ok: false, error: "..."}` and lets the LLM see it on the next iteration lets the agent recover — try different args, give up gracefully, or route around the failure. This is how "self-healing" agents actually work, and it's just `try/except` + result wrapping.
- **Streaming + tools don't mix easily.** OpenAI streams tool calls but the natural UX is "show the reasoning unfold step by step" — not "stream tokens of the reasoning." I went with `final` event delivering the answer as one block on the agent path. /chat still streams tokens for the cheap path. Two surfaces, two budgets.
- **Iteration cap behavior matters more than the cap itself.** A naive "we hit 5 iterations, no answer, done" is rude. Issuing one more LLM call with `tools=[]` forces the model to summarize what it found. Honest output (or even "I couldn't determine X") beats no output. Amber chip in UI surfaces the case.
- **Context window grows linearly with tool calls.** Every tool result lands in `messages`. A 5-iteration agent with 4 tool calls per iteration sees ~20 prior tool results plus the system prompt plus history on the final LLM call. Result size caps (240-char previews, 50-row list limits) are load-bearing — not premature optimization.
- **Adding a tool is two changes.** One schema entry, one dispatch function. No decorators, no registration ceremony. This is what "hand-rolled" buys you: total clarity on what's wired up. Compare to LangChain's `@tool` decorator + retriever class + chain composition.
- **In-band UUID validation pays for itself in one bug.** Live audit caught the model passing cluster *labels* ("Eijuuu References") where UUIDs were expected — Postgres returned an opaque "22P02 invalid input syntax" error, the agent recovered but burned ~300ms × 3 calls. Added a regex pre-check that returns "expected UUID, got 'Eijuuu References' — call list_clusters() first to get the UUID" instead. Same defensive pattern as the rewriter/reranker — make errors helpful before they reach the model.

---

## 2026-05-16 — `(this commit)` — docs housekeeping pass #3

**Shipped:**
- README rewrite — status badge bumped to *P1 ✅ · P2 🟢 ~95% · P3 🟡 20%*. "What works today" rewritten with the seven shipped capabilities since pass #2 (rewriter, reranker, clustering, graph UI sweep, media previews, agent mode). A/B examples in the commands section now cover all 5 retrieval flag combos.
- ARCHITECTURE additions — full data flow for `/agent` (5-iter LLM-tools loop with the in-band-error pattern + iteration-cap fallback), full data flow for `recompute-clusters` (k-means + LLM-naming + members_hash reuse), three new invariants (#15 in-band tool errors, #16 agent input bounds, #17 agent-and-chat-share-substrate).
- EVALS expanded — A/B section now documents `EVAL_QUERY_REWRITE` and `EVAL_RERANK` flags alongside `EVAL_STRATEGY`. Added the cumulative deltas table showing how each layer (graph-aug → rewriter → reranker) bought a distinct slice of recall/precision. Limitations section acknowledges the agent-quality eval gap.
- LEARNING grew Part 3.5 — six new concept sections covering query rewriting, LLM-as-judge reranker, agentic clustering (k-means + LLM-naming + members_hash), the agent loop hand-rolled, the agent ↔ retrieval relationship, and the "no LangChain through P3" reaffirmation. Each carries an interview-ready soundbite.
- PROGRESS placeholder backfill — 6 entries that said `(this commit)` now carry their actual hashes (`28bbd7e`, `e9c08fe`, three at `6632d3f`, `b05351f`).

**What I learned:**
- **Per-feature ADRs + ROADMAP entries kept the per-decision documentation honest, but the overview docs (README, ARCHITECTURE, LEARNING) drifted because no individual commit "owned" them.** Same lesson as housekeeping pass #2. The fix isn't more discipline; it's accepting that overview docs need a periodic sweep, and scheduling it (every ~5 feature commits, when the README status badge becomes a lie).
- **The "shipped + learned" template scales.** Looking back at the PROGRESS log, every entry follows the same shape: bullets of shipped pieces, bullets of lessons. Future-me reading this five months from now gets both *what's there* and *what to remember about why* in one pass. Worth keeping the template strict.
- **Update the LEARNING soundbites alongside the code, not after.** A soundbite written cold months later is a guess at what mattered. Written the same day as the code, it captures the actual reasoning while it's still load-bearing.

---

## 2026-05-16 — `(this commit)` — P3.2: reflection loop (LLM-as-judge + bounded retry)

**Shipped:**
- `services/reflection.py` (new) — `reflect_on_answer(openai, question, answer, tool_log)` returns a `ReflectionJudgment(score 1-5, issues, should_retry, ...)`. JSON mode, temp 0, max 200 tokens. Defensive: parse failures default to score=5/should_retry=false (cost of forced retry on every transient error > cost of a missed retry).
- `routers/agent.py` refactored — extracted `_stream_attempt(question, history, attempt_label)` as an inner async generator using nonlocal accumulators (async gens can't return values cleanly). First attempt runs as before; on completion the judge runs; on low score + should_retry, a second attempt runs with the rejected answer + judge feedback in the synthetic history. Cap at 1 retry. Every SSE event tagged with `attempt: "first" | "retry"`.
- New SSE event `reflection {score, issues, retrying, elapsed_ms}` between the two attempts.
- Migration `0013_chat_logs_reflection` — adds `reflection_score`, `reflection_retried`, `reflection_issues` to chat_logs. Tool call entries in `agent_tool_calls` jsonb also carry an `attempt` tag.
- `config.reflection_enabled: bool = True` + `reflection_retry_below: int = 4` settings. Threshold enforced server-side too — we don't trust the model's `should_retry` flag in isolation.
- `services/reflection.build_retry_feedback(answer, judgment)` formats the user-role feedback message that goes into the retry's history.
- ChatPanel — new `ReflectionInfo` type + setter + event handler. Color-tiered chip (emerald→lime→amber→orange→red across 5→1) with expandable issues. `reflectionRetried` on the message renders "retried" in the agent-iterations chip. `AgentTrace` detects the first-to-retry boundary in `steps` and renders a "retry attempt" divider.
- ADR-021 documenting the design + the tradeoffs (calibration-collapse risk, cap-at-1 reasoning, the why behind defaulting parse failures to score=5).
- **Bonus: `TODAY IS:` header prepended to both /chat and /agent system prompts at message-build time.** Models have no built-in concept of "today" — without this, questions like "how much time until eijuuu's birthday" and "how old is X now" failed because the model couldn't compute durations against the present. Validated in live audit: two "how much time does sumit have to prepare a gift" runs in P3.1 had the agent honestly admit it couldn't find prep-time info; with the date header it can now compute `Aug 30 - today` directly (107 days, May 15 → Aug 30). Four-line change in `services/llm.py` + `services/agent.py`.
- **Audit-driven amendment: SECOND judge call after retry, ship the better-scoring attempt.** The very first reflection-enabled run with the new TODAY header surfaced a UX bug — the chip read `judge 2/5 — retrying with feedback` next to an answer that was actually correct (107 days). The 2/5 was the *rejected* attempt's score; the shipped answer was never scored. User asked, correctly, "shouldn't there be 2 judge calls?" Folded the fix into the same uncommitted batch: migration `0014` adds `reflection_score_first`, router runs the judge once more after retry, ships whichever attempt scored higher (tie → retry), re-emits the `final` event tagged `attempt: "first-restored"` when the retry was worse so the UI bubble corrects itself. ADR-021 amended in-place with the same-day reversal.

**What I learned (from the amendment):**
- **Caps in design docs need to consider UI honesty.** "Cap at 1 retry, no second judge" was technically defensible (saves $0.0001) but the chip became dishonest. Caps should be about *what the system does*, not about avoiding work that user-facing artifacts need. Once you put a score next to an answer, you owe the user a score that *describes that answer*.
- **Auditing right after shipping is when you catch the design-vs-experience gap.** ADR-021 looked sound on paper. The audit run showed it had a subtle issue 30 seconds after the first real use. The lesson is *do the audit before the commit*, not after — same-day reversal cost almost nothing.
- **"Ship the better one" needs a way to *undo* the bubble update.** The UI shows the latest `final` event's content by default. When retry was worse, we had to send another `final` with the first answer to put it back. The `attempt: "first-restored"` tag lets the UI distinguish "the agent just answered" from "we changed our mind." Subtle but load-bearing.

**What I learned:**
- **Reflection is a different kind of self-correction than the in-band tool-error pattern.** Tool errors land in the message history and the agent recovers within the same loop. Reflection runs *between* loops — the judge sees the FINAL answer, not intermediate state, and decides whether the whole attempt was good enough. Both patterns ship in P3 but they're distinct: in-band errors fix *bad calls*, reflection fixes *bad answers*.
- **The retry isn't "try the exact same thing again" — it's "try again with new context."** The agent's second-attempt history includes the rejected answer + the judge's specific issues. The model usually responds by issuing *different* tool calls (more `read_node` if grounding was thin, additional `search_memory` if context was missing). That's why the same agent loop without code changes produces meaningfully different results on retry.
- **Async generators in Python can't return values cleanly.** Tried four times to refactor the router with a helper that yields events AND returns a result tuple. Each time the closing semantics around `StopAsyncIteration(value)` got messy. Settled on closures over outer-scope mutable state via `nonlocal`. Less elegant than I wanted; the cleanest workable shape.
- **Calibration collapse is a real risk for same-model judges.** The judge is gpt-4o-mini; the agent is gpt-4o-mini. The judge might agree with the agent's mistakes (same biases, same blind spots). Mitigated by the judge seeing the tool log (it can verify grounding against actual data), but not eliminated. Real independence would need a different model class — interesting future work, not blocking v1.
- **The threshold belongs in config, not the prompt.** I had the judge prompt say "set should_retry=true when score < 4." Realized that's two places that have to agree (the prompt's threshold and `REFLECTION_RETRY_BELOW=4`). Moved the enforcement to the router (`should_retry AND score < settings.reflection_retry_below`) — the prompt's `should_retry` becomes advisory, not authoritative. One place to change the threshold.
- **The retry pattern is "user feedback," not "system feedback."** The retry's synthetic message is in the user role, not system. Two reasons: (a) the model treats user messages as authoritative direction in a way that's natural here, (b) keeping the system prompt static across both attempts lets us cache it eventually. Subtle prompt-engineering call but it matters.
