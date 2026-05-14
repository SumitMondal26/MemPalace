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

## 2026-05-15 — `5a23188` + (this commit) — golden set 8→20, query rewriting on multi-turn

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
