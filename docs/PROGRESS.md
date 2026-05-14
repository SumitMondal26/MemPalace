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
