# Mem Palace — Study Guide

What you built, what each piece *means*, why we made the choices we made, and the soundbites to use in interviews. Organized by phase. Read top to bottom once; come back to sections when needed.

---

## 0. What you built (one paragraph)

A visual AI memory graph. Users sign up, create nodes (notes / docs / URLs), see them as floating glowing spheres in a 3D canvas, and chat with their memory. Behind the scenes: every node's content is chunked, embedded, and stored in pgvector; an auto-connect button creates semantic edges between similar nodes; chat questions retrieve via 1-hop graph-augmented search and stream the response over SSE; an eval harness quantifies retrieval quality so every change is measured. Two services (Next.js + FastAPI), one managed backend (Supabase), `docker compose up --build` for dev.

---

# Part 1 — P1 Foundation Concepts

For each: **what it is**, **why it matters**, **where it lives in our code**, **interview soundbite**.

## 1.1 Retrieval-Augmented Generation (RAG)

**What.** Instead of asking the model what *it* knows, you (a) retrieve relevant text from your own data, (b) stuff it into the prompt as context, (c) ask the model to answer using *that* context. The model becomes a stateless reasoner over data you control.

**Why.** Three reasons in one breath:
1. **Freshness** — the model's training data is frozen; your data isn't.
2. **Citations** — you can prove where the answer came from.
3. **Privacy + cost** — you don't fine-tune; you bring your own context only when needed.

**Where in our code.** `apps/api/app/services/retrieval.py` + `apps/api/app/services/llm.py` + `supabase/migrations/0001_init.sql`.

**Soundbite.** *"RAG is grounding generation in retrieval. The model is the language engine; the vector DB is the knowledge engine. Decoupled, swappable."*

## 1.2 Embeddings & vector search

**What.** An embedding is a fixed-size vector (we use 1536) that represents the *meaning* of a chunk. Two pieces of text that mean similar things end up close in this 1536-dim space. Distance = cosine similarity (the angle between vectors).

**Why.** Search by meaning, not keywords. "What is multi-head attention?" finds the chunk that says "Multi-head attention performs..." even if the chunk doesn't contain "what is".

**Where.** OpenAI `text-embedding-3-small`; stored as pgvector `vector(1536)`; queried with `<=>` cosine distance; HNSW index for sub-millisecond approximate nearest neighbor.

**Soundbite.** *"Embeddings turn text into points in geometric space; retrieval is nearest-neighbor in that space. Cosine similarity because we care about direction, not magnitude."*

## 1.3 Chunking

**What.** Splitting long text into smaller pieces (we target ~500 tokens with 50-token overlap) before embedding.

**Why.**
- **Embedding quality**: one big paper → one blurry vector. 500-token chunks → specific vectors.
- **Context window**: top-k of small chunks fits in the prompt budget; one giant chunk doesn't.
- **Overlap (~10%)**: protects sentences that straddle chunk boundaries.

**Where.** `apps/api/app/services/chunking.py` using `tiktoken.cl100k_base`.

**Soundbite.** *"Chunk size trades retrieval precision against context completeness. ~500 tokens with 10% overlap is the boring-but-strong baseline. Measure recall@k on a golden set before optimizing."*

## 1.4 JWT verification (HS256 + JWKS)

**What.** Two signing approaches: HMAC with a shared secret (HS256) or asymmetric public/private key (ES256/EdDSA, public key fetched from JWKS endpoint).

**Why.** Supabase historically used HS256; new projects default to asymmetric. Our verifier reads `alg` from the token header and picks the right path. This works across both eras and survives key rotation.

**Where.** `apps/api/app/deps.py::get_claims`.

**Soundbite.** *"Asymmetric JWT signing means the public key can be everywhere — CDN-cacheable, no rotation drama. JWKS is the standard. We support both legacy HS256 and JWKS so the verifier doesn't break when Supabase rotates anything."*

## 1.5 RLS + the two-key pattern

**What.** Row-Level Security in Postgres: every query is filtered through a policy that sees `auth.uid()` from the JWT. Two Supabase keys: anon/user (RLS applies) vs service-role (bypasses RLS).

**Why.** Defense in depth. A bug in FastAPI can't leak data because Postgres refuses the query. Mix the two keys deliberately, never accidentally.

**Where.** `supabase/migrations/0001_init.sql` (RLS policies); `apps/api/app/deps.py::supabase_user / supabase_admin`; `apps/api/app/routers/ingest.py` (canonical example of "authorize as user, work as admin").

**Soundbite.** *"RLS is the floor, not the only line. Two-key pattern: user JWT for authentication and authorization, service-role for explicit background work."*

## 1.6 SSE for streaming

**What.** Server-Sent Events — long-running HTTP response with `Content-Type: text/event-stream`, frames separated by `\n\n`. One-way, plain HTTP.

**Why.** Matches LLM token streaming exactly. No upgrade handshake, plays through proxies, browser handles framing for you. WebSockets are overkill for one-way data.

**Where.** `apps/api/app/routers/chat.py` (server, `StreamingResponse`); `apps/web/components/ChatPanel.tsx::consumeStream` (browser, `fetch.body.getReader` because EventSource is GET-only).

**Soundbite.** *"SSE for token streaming. WebSockets only when I need full duplex — chat with a bot doesn't."*

## 1.7 Two-tier client state

**What.** Zustand holds the server-mirror (what's in the DB). React Flow's internal state (and now react-force-graph's) holds transient UI (drag positions during interaction). They reconcile on the commit boundary (drag-stop).

**Why.** Two competing needs: 60fps smooth UI vs persistent server state. Drag-stop is the commit moment.

**Where.** `apps/web/lib/store.ts` (Zustand); `apps/web/components/GraphCanvas.tsx`.

**Soundbite.** *"Two state systems on purpose: Zustand as the durable mirror, React Flow / three.js as transient UI. The drag-stop event is where they reconcile. Same pattern Figma and Linear use."*

---

# Part 2 — P2 Concepts (added 2026-05-14)

## 2.1 Recall@k — "did we find it?"

**What.** For each test question, you know which node *should* answer it. Run retrieval, get top-k results. Did the right node appear in the top k? Yes/no per question. Average over all questions = recall@k as a percentage.

**Concretely.** If 8 out of 10 questions have the right answer in their top 5 results → **recall@5 = 80%**.

**Why.** Recall@k tells you "is the right thing in the user's view?" — a yes/no sanity check at a specific cutoff.

**Where.** `apps/api/eval/run_evals.py::main` aggregation block.

**Soundbite.** *"Recall@k = the fraction of cases where the right answer appears in the top-k results. It's a yes/no count at a fixed cutoff. Saturates at 100% on small corpora; once it does, switch to MRR for finer signal."*

## 2.2 MRR (Mean Reciprocal Rank) — "did we rank it well?"

**What.** For each question, look at the rank of the right answer. Compute `1/rank`:
- Rank 1 → 1.0
- Rank 2 → 0.5
- Rank 3 → 0.33
- Not found → 0.0

Average across all questions = MRR.

**Concretely.** If 6 questions ranked the right answer #1 and 2 ranked it #2: MRR = `(6×1.0 + 2×0.5) / 8 = 0.875`. That's exactly our number.

**Why.** Penalizes ranking the right answer low. Stays meaningful even when recall@5 is saturated at 100%.

**Where.** Same file as 2.1.

**Soundbite.** *"MRR = average of 1/rank across all queries. 1.0 = perfect (every answer at rank 1). 0.5 = average rank 2. Use it instead of recall@k when you've maxed out recall."*

## 2.3 Eval-driven engineering

**What.** Build a small repeatable measurement. Take baseline numbers. Make a change. Re-measure. Keep if better, revert if not. Document either way.

**Why.** Without measurement, every retrieval change is religion. With it, every change is engineering. **This is the core RAG engineer skill.**

**Where.** `make evals` → `apps/api/eval/run_evals.py` → `apps/api/eval/golden.json`.

**Soundbite.** *"Build the eval harness before any retrieval optimization. Anchor numbers, change one thing, re-measure. The discipline distinguishes RAG engineering from RAG vibes."*

**The loop:**
```
1. Identify a gap                ("graph isn't used by retrieval")
2. Measure baseline              (recall@5 = 100%, MRR = 0.875 at k=10)
3. Implement a fix               (graph-augmented retrieval)
4. Re-measure                    (k=1: baseline 75% → graph 100%)
5. Keep / revert                 (kept; documented +25% lift)
6. Document                      (commit message + ADR)
```

You did this exact loop in one session. Internalize the shape.

## 2.4 The "embedding similarity ceiling" on short text

**What.** Cosine similarity over short text (notes, sentences) caps around 0.4-0.6 even for clearly related pairs. Long passages cluster at 0.8+. Two unrelated short sentences with the same *template* can score higher than two related sentences in different forms.

**Concretely.** "my name is sumit" + "sumit is 28 years old" → 0.617 (related, but capped). "Eijuuu is sumit's girlfriend" + "Eijjuu is 25 years old" → 0.536 (unrelated, but high because both are "X is Y" templates with similar names).

**Why this matters.** Threshold values that make sense for paragraph-length chunks (~0.7+) produce zero edges on short notes. You discover this by measuring, not by reading docs.

**Where.** Discovered while tuning auto-connect threshold (logged in `docs/RAG_NOTES.md` and ADR-010).

**Soundbite.** *"Embedding similarity captures surface form alongside semantic content, inseparably. Short text peaks around 0.6, not 0.9. The fix isn't more rewriting — it's hybrid retrieval (BM25 alongside vector) or LLM-rerank for entity resolution."*

## 2.5 Pairwise similarity as a graph builder

**What.** Compute pairwise cosine over node-mean embeddings (mean of each node's chunk embeddings), insert edges where similarity ≥ threshold. All in SQL with pgvector's `AVG(vector)` aggregate + `<=>` cosine operator.

**Why.** Retrieval is just nearest-neighbor search; a graph is just nearest-neighbor relationships materialized. Same operation, two outputs (a chat answer vs a set of edges).

**Where.** `supabase/migrations/0003_rebuild_semantic_edges.sql`.

**Soundbite.** *"Auto-connect is pairwise cosine over node-mean embeddings, computed entirely in SQL via pgvector. Idempotent — re-runs replace previous semantic edges. The expensive AI work happens in the database, not in Python."*

## 2.6 Graph-augmented retrieval (1-hop neighborhood expansion)

**What.** Vector search returns top-k chunks (the "seeds"). For each seed's node, walk edges (manual + semantic, undirected) to find connected nodes, fetch their top-N chunks for this query, union with seeds. All in one SQL function.

**Why.** Pure vector search ignores the graph entirely. Graph expansion converts "the right answer is one connection away from the wrong top-k pick" into "the right answer is in the result set." **This is what makes the graph operational rather than decorative.**

**Where.** `supabase/migrations/0004_match_chunks_with_neighbors.sql`; called from `/chat` via `apps/api/app/services/retrieval.py::search_chunks_with_neighbors`.

**Measured impact.** At k=1 stress test on our 8-case golden set: recall@5 75% → 100%, MRR 0.750 → 0.875.

**Soundbite.** *"My graph-augmented retrieval does vector top-k plus 1-hop graph expansion in one DB round-trip. At realistic scale (small k), it converts false-friend misses into hits via the semantic edge cluster — recall@5 lifts 25 points in stress tests. The graph isn't decoration; it's a retrieval substrate."*

## 2.7 The "decoration vs operational" axis

**What.** A new mental model: every feature you add is on a spectrum from "decoration" (visible but doesn't shape behavior) to "operational" (changes outputs).

**Examples in our project:**
| Feature | Decoration or operational? |
|---|---|
| Node colors by type | Decoration |
| Floor grid toggle | Decoration |
| 3D vs 2D canvas | Decoration (same data, different render) |
| Semantic edges (before graph-RAG) | **Decoration** |
| Semantic edges (after graph-RAG) | **Operational** — they shape retrieval |
| Auto-connect button | Operational (it builds the structure that drives retrieval) |
| Trace UI in chat | Decoration (informative, doesn't change answers) |
| Relevance threshold filter | Operational (changes which chunks the LLM sees) |
| Eval harness | Operational at the meta-level (changes which retrieval implementations get shipped) |

**Why this matters.** When asked "what does feature X do?" the strong answer is "it changes outputs Y by mechanism Z." If you can only describe X visually, it's decoration. Decoration isn't bad, but it's not the work an AI engineer is hired to do.

**Soundbite.** *"Every feature in my project is either decoration or operational. The graph used to be decoration. Adding graph-augmented retrieval made it operational — measurable lift in retrieval quality. That distinction is the project's most important pivot."*

---

# Part 3 — P2.5 Concepts (added 2026-05-15)

What we built in the second wave of P2 work. Each one teaches a different RAG-engineering muscle.

## 3.1 Best-pair-chunk for cross-node similarity

**What.** When scoring "how similar is node A to node B?", instead of comparing `mean(A.chunks)` to `mean(B.chunks)`, take the **MAX** over all chunk-pair Cartesians:

```
similarity(A, B) = MAX over (chunk_a in A, chunk_b in B) of cosine(chunk_a, chunk_b)
```

**Why.** Mean-of-chunks dilutes a long doc into a generic-topic vector. A 23-chunk paper's mean lives in "AI paper space" and matches nothing specifically. Best-pair-chunk: as long as ONE chunk of A matches some chunk of B strongly, the connection forms.

**Where.** `supabase/migrations/0005_rebuild_semantic_edges_v2.sql` — the `pair_max` CTE.

**Soundbite.** *"Best-pair-chunk is to mean-of-chunks what max-pooling is to average-pooling. For long docs, the average is a smear; the max is the actual best evidence of relatedness."*

## 3.2 kNN per node (relative ranking)

**What.** For each node, take its **top-K most-similar partners** as edges. K=3 default. No global threshold.

**Why.** A single global threshold can't serve all node-pair categories — short notes peak at 0.6, long-doc-mean pairs peak at 0.4, related entities in different sentence templates peak at 0.4. kNN per node adapts naturally — every node gets ~K of its nearest, regardless of absolute scale.

**Where.** Same SQL function (0005), the `bidirectional` + `ranked` + `selected` CTE chain.

**Soundbite.** *"Threshold tuning is symptom; the disease is using a single absolute knob over heterogeneous data. kNN replaces the absolute knob with relative ranking — each node is its own context."*

## 3.3 Min-weight floor (kNN's safety net)

**What.** After kNN selects top-K partners per node, drop any edge with similarity below an absolute floor (0.25 default).

**Why.** kNN guarantees connectivity but not quality. A node with 4 weak partners and no strong ones will have its top-3 forced through anyway — those edges are usually "people doing things together"-style surface-form noise. The floor catches them.

**Where.** Migration 0006, the `selected` CTE's `where rn <= k_neighbors and similarity >= min_weight`.

**Soundbite.** *"kNN is for connectivity; the floor is for quality. Both layers needed, neither sufficient alone."*

## 3.4 Multi-turn conversation memory

**What.** Each `/chat` request includes the prior 6 messages as a `history` array. The server splices them between the system prompt and the current user-with-Context turn before calling the LLM.

**Why.** Without history, every chat turn is a cold start — the model can't resolve "her age," "what about it?", "the second one". With history, follow-ups work like real conversation.

**Where.** `apps/api/app/routers/chat.py::ChatRequest` + `apps/api/app/services/llm.py::stream_chat_messages` + `apps/web/components/ChatPanel.tsx::send`.

**The known weakness.** Retrieval still fires on the *literal current question*. "How many heads?" alone has weak embedding signal — vector might miss the right chunk even though the model would understand the question via history. Fix: **query rewriting** (one LLM call uses prior turns to rewrite the question into a self-contained search query before embedding). Documented as P3 work in ADR-014.

**Soundbite.** *"Multi-turn layers conversation memory on top of RAG, doesn't replace it. Each turn re-runs full retrieval on the current question; the model uses history to resolve pronouns. The bridge between them — query rewriting — is the natural next layer."*

## 3.5 AI observability (chat_logs + /insights)

**What.** Every chat turn writes one row to a `chat_logs` table capturing: question, answer, full prompt array, cited node IDs, model meta, retrieval stats, per-stage timings (embed/search/llm), token counts (via `stream_options.include_usage`), computed $ cost, and status. A `/insights` page renders aggregate cards + per-row drill-down with the raw prompt visible.

**Why.** Without observability, every retrieval bug is anecdote. With it, every bug is reproducible. We caught a hallucination (the gym-question answer with no `[N]` citations) by reading the raw prompt in /insights — that's the loop a real AI engineer runs daily.

**Where.** Migration 0007 creates the table; `apps/api/app/routers/chat.py` writes each row at end of stream; `apps/web/app/insights/` renders the dashboard.

**Soundbite.** *"Observability isn't optional in production AI. Building it in-house first means I understand what Langfuse/Phoenix actually store; migration to OpenTelemetry later is straightforward — every chat_logs row maps to an OTel span. Until then, I own the data, the schema, and the queries."*

## 3.6 Cost + token accounting

**What.** OpenAI's chat-completion streaming returns token usage in the final event when you set `stream_options={"include_usage": true}`. Embeddings return usage on the response object directly. We capture both, then compute $ cost via a per-model price table.

**Why.** Most teams either drastically over- or under-estimate LLM costs. Tracking from day one builds intuition. Surprise bills happen to teams who didn't.

**Real numbers from our data.** ~$0.0001 to $0.0004 per chat turn at gpt-4o-mini + text-embedding-3-small ≈ 1000-5000 turns per dollar. Embedding cost is essentially free; LLM input + output tokens dominate.

**Where.** `PRICE_PER_TOKEN` map at the top of `apps/api/app/routers/chat.py`.

**Soundbite.** *"I track every token and every cent from chat turn one. text-embedding-3-small is essentially free; gpt-4o-mini is cheap; cost discipline is just tracking + a price table that ages with OpenAI's docs. Real LLM bills come from accidentally retrying expensive calls in loops, not from per-request pricing."*

## 3.7 Weight-modulated visualization (data layer + view layer separation)

**What.** Edges in the canvas have continuous weights (cosine similarity) but render in **discrete tiers**: slate (weak), cyan (medium), amber (strong). Width + particle density also modulate with weight. Legend in canvas corner shows the tier boundaries.

**Why.** First attempt: continuous HSL gradient. Result: muddy purples in the middle range that were hard to compare. Three discrete hues read instantly. **Lesson: gradient looks smarter on paper; discrete tiers are easier on actual eyes.**

**Architectural consequence.** The data layer keeps full-precision weight (we don't filter weak edges out — kept and rendered faded). The view layer chooses how to bin and color. This separation is the right pattern: never lose information at storage; render appropriately at display.

**Where.** Tier definitions live in `apps/web/lib/edgeTiers.ts` so both the canvas and the legend read from the same source of truth.

**Soundbite.** *"Data layer keeps everything; view layer filters by importance. Same idea as showing high-confidence search results prominently and low-confidence ones in a 'less relevant' section. I don't drop weak edges — I render them faintly and let the eye do the filtering."*

## 3.8 Unified add-memory flow (UX architectural lesson)

**What.** Three buttons + a modal collapsed into one button + dropdown + sidebar draft form. The sidebar slot does double duty: type-aware draft form when in draft mode, edit form when a node is selected. Mutually exclusive at the store-state level.

**Why.** Three buttons crowded the header; modals add a third visual layer. One slot doing double duty = simpler mental model.

**Architectural consequence.** When state slices are *conceptually* mutually exclusive (drafting vs editing), encode that in the store: `selectNode` clears `draftType`, `startDraft` clears `selectedNodeId`. Impossible states become *unrepresentable*, not just *unhandled*.

**Where.** `apps/web/lib/store.ts` (the `draftType` slice + actions); `apps/web/components/Sidebar.tsx` (render branching).

**Soundbite.** *"Mutually-exclusive UX states should be mutually-exclusive store state. If a user can't logically be in two states at once, my code shouldn't even allow representing both. Cleaner than every component checking 'am I drafting OR editing?' at runtime."*

---

# Part 3.5 — Late-P2 + P3.1 Concepts (added 2026-05-16)

The retrieval stack grew three new layers and an entirely new endpoint. Each one fixes a distinct failure mode the layers below couldn't.

## 3.5.1 Query rewriting (the multi-turn fix)

**The problem.** Multi-turn chat sends prior messages to the LLM at *generation* time, but the *retrieval* step embeds only the latest message. So `"how old is she?"` retrieves whatever is geometrically nearby — often the wrong age node — because the embedder has no signal that "she" refers to a specific entity from the previous turn.

**The fix.** Before embedding, one cheap LLM call (gpt-4o-mini, JSON mode, temp 0, max 120 tokens) takes the latest question + last 4 turns and rewrites the question into a standalone search query: `"how old is Eijuuu?"`. The embedder sees *that*. The user-visible question still goes into the prompt verbatim — the rewriter only steers retrieval, not generation.

**Why split retrieval input from generator input.** Two separate concerns. If the rewriter is wrong (subtle paraphrase), the LLM still answers the user's literal words. The rewriter is plumbing for the embedder, not a translator for the user.

**Defensive design.** Three failure modes (parse error, API timeout, junk JSON) all share one fallback: return the original question. Rewriter never blocks `/chat`.

**Measured.** Recall@1 80→85%, MRR 0.885→0.910. Two cases flipped to rank 1 (vague-partner, vague-her-age). Skipped on single-turn (no history to rewrite from).

**Soundbite.** *"Multi-turn chat had asymmetric context — generator could see history, retriever was blind to it. Fixed with one LLM call between user input and embed_query that rewrites pronouns into entity names. Defensive: any failure falls back to the original question. Measured +5pp recall@1 / +0.025 MRR. Skipped on single-turn — zero added cost on the dominant case."*

## 3.5.2 LLM-as-judge reranker (the precision fix)

**The problem.** Vector retrieval is *recall-optimized*. Top-k chunks are ranked by cosine similarity, computed independently. Two chunks with similarity 0.45 vs 0.44 are essentially tied — the embedder has no way to know which actually answers the question. The LLM then gets two near-tied chunks in the prompt and may cite the wrong one (caught live in /insights: "how old is he?" returned `[1] sumit's age @ 0.45` and `[2] eijjuu's age @ 0.44`, model picked [2]).

**The fix.** Over-fetch 2× from retrieval, send top-N (max 8) candidates + question to gpt-4o-mini in JSON mode, get back ranked indices, reorder, take top-K. The judge sees ALL candidates AND the question together — it can read both chunks and reason about which one matches.

**Auto-skip when the work is unnecessary.** If the top candidate's similarity is more than 0.10 above the second, skip the LLM call entirely. The cost guard preserves the cheap-when-easy property.

**Why LLM-as-judge over a cross-encoder.** Cross-encoders are faster (~50ms) and free per call after the model download (~400MB), but they need a Python ML dep + model weights in the API container. LLM-as-judge ships in zero infra changes for ~$0.0001/turn. Easy to swap to a cross-encoder later if cost or latency demand it.

**Measured.** Recall@1 85.7→**95.24%** (+9.5pp), MRR 0.914→**0.976**. Three cases flipped to rank 1 (kenojo from rank 5!). Largest single-PR retrieval lift in the project's history.

**Why over-fetch matters.** Without `fetch_k = body.k * 2`, the reranker would just be reordering the same 5 chunks vector retrieval was going to send. The win comes from candidates 6-10 — chunks the reranker can promote from "not in top-K" to "actually the answer".

**Soundbite.** *"Recall and precision are different problems. Vector retrieval optimizes recall; near-tied candidates need a precision step. Built an LLM-as-judge reranker that over-fetches 2x, sends candidates + question to gpt-4o-mini, gets ranked indices back, reorders. Auto-skips when top-1 is clearly above top-2 — cost guard. Measured +9.5pp recall@1, +0.062 MRR. Cross-encoder would be faster but adds an ML dep — LLM-as-judge ships in zero infra."*

## 3.5.3 Agentic topic clustering (k-means + LLM-naming)

**The shape.** Two stages, deliberately split.
1. **K-means on node-mean embeddings** (sklearn MiniBatchKMeans). Deterministic, math, no LLM. K-selection by silhouette score with sub-sampling for large n.
2. **LLM naming, one call per cluster** (gpt-4o-mini, JSON mode, max 30 tokens). The model sees member titles, returns a 2-3 word topic label.

**Why split this way.** Letting the LLM do both jobs (group AND label) costs ~10× more and doesn't scale past ~100 nodes (token limit). Letting an algorithm do the math and the LLM do the writing is the clean separation: math gives precision, LLM gives readability. People sometimes call this an "agentic workflow"; honestly it's just well-chosen division of labor.

**Phase 1 scaling: members_hash.** Compute `sha256(sorted(member_ids))` per cluster. Before naming, look up the previous run's `(hash → label)` map; matching hashes reuse the previous label and skip the LLM call. In steady state most clusters between two recompute runs have identical membership — this saves ~$0.0001 × N unchanged clusters per recompute.

**What clustering buys the canvas.** Two new tools the agent can use (`list_clusters`, `read_cluster_members`) to navigate by topic instead of keyword search. Cluster colors in the 3D canvas + clickable legend with focus-others-dim.

**Honest limit.** K-means assigns by embedding *proximity*, not meaning. A "BTS songs" note can land in a Books cluster because both project as "personal preferences" in vector space. The fix isn't more math; it's letting an LLM read the actual content (LLM-as-clusterer, deferred to a future iteration).

**Soundbite.** *"Topic clustering is k-means on node-mean embeddings + per-cluster LLM-naming. Math for grouping, LLM for naming — splitting them costs ~10x less than letting the LLM do both. members_hash fingerprints cluster membership; on re-runs the unchanged clusters skip the LLM call. Phase 1 scaling — sklearn substrate so it scales to ~10k nodes without architectural change."*

## 3.5.4 The agent loop (P3.1)

**The shape, in 30 lines.**

```python
messages = [system, ...history, user_question]
for iter in range(MAX_ITERATIONS):                  # cap = 5
    resp = await openai.chat.completions.create(
        messages=messages,
        tools=TOOL_SPECS,
        tool_choice="auto",
        max_tokens=800,
    )
    msg = resp.choices[0].message
    if not msg.tool_calls:
        yield AgentFinalAnswer(msg.content); break
    messages.append(msg)
    for call in msg.tool_calls:
        result = await dispatch_tool(call.name, parsed_args, ctx)
        yield AgentToolCall(...) ; yield AgentToolResult(...)
        messages.append({"role": "tool", "tool_call_id": call.id, "content": ...})
```

That's the heart of every agent framework you've heard of (LangChain, LangGraph, AutoGPT, OpenAI Assistants). Hand-wrote it because the loop is small enough to read in 30 seconds and you'll know what the frameworks are hiding.

**Tools = JSON schemas + dispatch functions.** The schema teaches the LLM what's possible. The dispatch teaches our type checker what's safe. Adding a tool = one schema entry + one async function. No decorators.

**The big mental shift: errors belong in the message history, not the call stack.** A tool dispatch that raises Python exceptions kills the agent. A tool that returns `{ok: false, error: "..."}` and lets the LLM see it on the next iteration lets the agent recover (try different args, give up gracefully, route around). Validated live: the agent self-recovered from passing labels-as-UUIDs by calling `list_clusters` first.

**Streaming + tool calls don't mix easily.** OpenAI streams tool calls but the natural UX is "show the reasoning unfold step by step" — not "stream tokens of the reasoning." The agent path delivers the final answer as one `final` event. /chat still streams tokens for the cheap path. Two surfaces, two budgets.

**Iteration cap behavior matters more than the cap itself.** When we hit `MAX_ITERATIONS=5` without a final answer, we issue ONE more LLM call with `tools=[]` — forces the model to summarize what it found. Honest output ("I couldn't determine X") beats truncation.

**Soundbite.** *"Hand-wrote the agent loop, ~200 lines, no framework. The model sees four read-only tools — search_memory, read_node, list_clusters, read_cluster_members — picks which to call, my server runs them, results go back into the conversation as 'tool' role messages, model decides whether to call more tools or produce the final answer. Up to 5 iterations. The big lesson: tool errors belong in the message history, not the call stack — that's how the agent self-heals from its own mistakes without us hard-coding recovery logic."*

## 3.5.5 The agent ↔ retrieval relationship

**The single most important thing to internalize about agents:** they don't replace RAG, they *use* it.

```
                    ┌────────────────────────────────────┐
                    │       AGENT (P3) — the planner      │
                    │  Decides WHEN, WHAT, HOW MANY       │
                    └─────────────────┬───────────────────┘
                                      │ calls
              ┌───────────────────────┼─────────────────────────┐
              ▼                       ▼                         ▼
         search_memory          read_node              list_clusters
              │                       │                         │
              ▼                       ▼                         ▼
    [embeddings + chunking + graph + reranking + clustering — all of P1+P2]
```

Every retrieval improvement we shipped — chunking strategy, graph 1-hop, reranker, clustering — *makes the agent better*. The agent inherits the quality of its tools.

**Cost shape.** Agent ≈ 7× /chat for ~3× latency on average. Worth it for exploratory questions ("tell me everything about X"). Wasted for focused ones ("what's X?"). Real systems route between them.

**Soundbite.** *"Tools without good retrieval underneath are useless. The agent calls search_memory — that's pgvector + graph expansion + reranking under the hood. Every P1/P2 retrieval improvement makes every agent run shorter, cheaper, more accurate. The agent isn't a substitute for the retrieval pipeline; it's a planner that consumes it."*

## 3.5.6 Why we kept "no LangChain" through P3 (ADR-006 reaffirmed)

LangChain abstracts the agent loop into one method call. That's the *single most valuable thing to understand* in the project for interview purposes. Frameworks abstract exactly the part you want to internalize.

LangChain has had three major rewrites in 18 months — code from a year ago doesn't run today. Hand-rolled code is stable across OpenAI SDK minor bumps.

The decision is reversible per-feature. We may use LangChain (or LangGraph) at P3.5 if web-fetcher integration surface gets painful. Doesn't change the value of having hand-rolled the loop first.

**Soundbite.** *"I deliberately built the agent loop and retrieval pipeline by hand to internalize how they actually work. LangChain abstracts all of that, and at the level I was learning, those abstractions would have hidden the lessons. For a production system on a deadline I'd reach for it; for a portfolio piece designed to teach me AI engineering, hand-rolled was the right call."*

---

# Part 4 — Architecture & flows (still current)

## 3.1 Why two services

| Layer | Owns | Why this language/framework |
|---|---|---|
| Next.js (web) | UI, SSR, auth cookies, direct DB reads | React, App Router, cookie-friendly Supabase SSR |
| FastAPI (api) | Chunking, embedding, retrieval, chat stream, agents | Python AI ecosystem |
| Supabase | Postgres + pgvector + Auth + Storage + RLS | Managed, one source of truth |

## 3.2 Trust boundaries

| Layer | Trusts | Verifies |
|---|---|---|
| Browser | Supabase auth cookie | Nothing locally |
| Next.js middleware | Session cookie | Calls `auth.getUser()` per request |
| FastAPI | `Authorization: Bearer <JWT>` | HS256 secret OR JWKS public key |
| Postgres (RLS) | `auth.uid()` derived from forwarded JWT | Policies on every table |

## 3.3 The four flows you should know cold

1. **Signup** — auth.users inserted → SECURITY DEFINER trigger fires → profile + workspace created → JWT issued → cookie set.
2. **Ingest (file)** — Storage upload → POST /ingest → user-context ownership check → service-role download → extract → chunk → embed → INSERT chunks.
3. **Ingest (note/url)** — Sidebar Save → updateNode → fire-and-forget POST /nodes/{id}/embed → DELETE existing → chunk + embed → INSERT.
4. **Chat (graph-augmented)** — embed_query → match_chunks_with_neighbors (vector + 1-hop) → threshold filter → SSE stages/sources/tokens/done.

## 3.4 Auto-connect (semantic edges) flow

```
Click "✨ Auto-connect"
  → POST /workspaces/{id}/rebuild-edges
  → SQL: rebuild_semantic_edges
      → DELETE existing kind='semantic' edges
      → AVG(c.embedding) per node
      → cross-join, cosine similarity, threshold filter
      → INSERT new edges
  → frontend refetches edges, store updates
  → 3D canvas renders animated purple particles on new edges
  → force simulation pulls connected spheres into clusters
```

---

# Part 4 — Caveats (the honest list)

These are not failures — they're scoped tradeoffs. Each is interview ammunition.

1. **Ingestion is synchronous.** P2 → Redis + arq queue.
2. **No reranking yet.** P2 → cross-encoder or LLM rerank.
3. **No hybrid retrieval.** P2 → vector + Postgres tsvector + RRF.
4. **Long-doc representation is mean-of-chunks (coarse).** P2 → best-pair-chunk.
5. **No real agents.** P3.
6. **No tracing/observability.** P4 → OpenTelemetry → Langfuse.
7. **Race window on rapid embed.** P2 (single-writer queue per node).
8. **No tests.** P2.
9. **No production deploy.** Vercel + Fly.io planned.
10. **No multi-turn chat memory.** P2/P3.
11. **No faithfulness eval.** P3 — LLM-as-judge.
12. **Manual node-drag disabled** (3d-force-graph DragControls bug). P2 → reconsider when we touch the canvas.

---

# Part 5 — Interview prep

## 5.1 The elevator pitch (90 seconds)

> *"Mem Palace is a visual AI memory system I built to learn production RAG. Knowledge lives as nodes in a 3D force-directed canvas — notes, uploaded docs, URLs — and a user can chat with their own memory. The graph isn't decoration: an auto-connect feature builds semantic edges via pairwise cosine over node-mean embeddings, and chat retrieval uses 1-hop graph expansion alongside vector search. I built an eval harness with recall@k and MRR over a hand-curated golden set; every retrieval change gets measured before and after. At my last A/B test, graph expansion lifted recall@5 by 25 points in the realistic-scale stress test. Architecture is two services — Next.js for UI/auth, FastAPI for AI work — backed by hosted Supabase with pgvector. RLS at the DB layer means a bug in my API can't leak data across users. Honest tradeoffs: synchronous ingestion to be queued in P2, no rerank yet, no real agents until P3 — and that's the next milestone I'm working toward."*

## 5.2 Likely questions (with strong answers)

**Q: How do you measure RAG quality?**
*A: I built a JSON golden set of ~10 hand-curated question→expected-node pairs and a Python eval runner that scores recall@1/3/5/10 and MRR. `make evals` runs the full sweep. The runner uses an env var `EVAL_STRATEGY` so I can A/B compare retrieval implementations on the same dataset. I anchor baseline numbers, change one thing, re-measure. The loop matters more than the metrics — you build the discipline by running it religiously, even when you "know" the change helps.*

**Q: What does your graph actually do for retrieval?**
*A: Each chat query first does standard vector search to find top-k similar chunks (the "seeds"). The same SQL function then walks 1 hop through manual + semantic edges from each seed node and pulls in chunks from connected nodes. All in one round-trip. At realistic scale (small k), this catches cases where vector picks a "false friend" as the top hit — the right answer is one semantic edge away. I measured a recall@5 lift from 75% to 100% on my stress test, MRR from 0.750 to 0.875. The mechanism: surface-form-similar nodes cluster together via auto-connect, and that cluster contains the right answer when vector picks the wrong template.*

**Q: How do you handle "out of context" questions like "hello"?**
*A: A relevance threshold filter (currently 0.4) drops chunks whose cosine similarity to the question is below it. The system prompt then has a rule: if context is empty (or "no context found"), respond conversationally rather than refuse. So "hello" → no chunks pass threshold → conversational reply. "what is multi-head attention?" → confident chunks pass → grounded answer with citations. The UI also distinguishes: source chips render only when chunks survive the threshold, so the user visually knows when the answer is grounded vs chat.*

**Q: Why did you pick threshold 0.4 for graph-augmented retrieval?**
*A: I picked 0.65 first based on RAG-tutorial defaults — got 0 edges, so no graph at all. Probed the actual cosine similarities of clearly-related pairs in real data, found short notes peak at ~0.6 even when topically aligned. Lowered to 0.5, then to 0.4 once I needed to catch entity-relationship pairs (Eijuuu is sumit's girlfriend → 0.427 with sumit). The lesson: embedding similarity has a ceiling on short text because surface form competes with meaning. 0.4 catches related entities; 0.5 was too strict. **Without measurement I would've spent days tuning prompts when the real fix was a single number.***

**Q: What's the next thing you'd build?**
*A: Best-pair-chunk for long-doc similarity. Right now a long doc's "embedding" is the mean of its 20+ chunks, which lands in a generic-topic neighborhood far from any specific note. Best-pair-chunk would compute pairwise cosine over chunk pairs and use the max — so a doc connects to a note if any single chunk pair is highly similar. I'd ship it, re-run evals, and see if cases involving long-doc connections improve.*

---

# Part 6 — How to use this guide

- **First read**: top to bottom, once, in order. Note any soundbites that feel unnatural; rephrase them in your own voice.
- **Day before an interview**: re-read §5 (interview prep) plus the `What I learned` block of the most recent commits in `docs/PROGRESS.md`.
- **During refactors**: re-read the relevant Part 1 / Part 2 concept sections to remember why something exists.
- **Six months from now**: read §3 (architecture & flows) before debugging anything.

You shipped a working production-shape RAG system with measured graph-augmented retrieval and an eval harness in a small number of focused sessions. The interview story writes itself if you can speak to **why** as fluently as **what**.
