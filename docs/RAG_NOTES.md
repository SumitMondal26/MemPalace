# RAG Notes

Running learning log. Each concept gets: what it is, why we chose what we chose, what we'd revisit. Update as P1 → P4 advances.

## Embedding model

**Choice (P1):** `text-embedding-3-small`, 1536 dims, OpenAI.

**Why:** Cheap (~$0.02 / 1M tokens), strong on general retrieval, native to OpenAI auth we already have, and 1536 is a tractable index size for HNSW.

**Tradeoff:** Lock-in to OpenAI for now. The `embeddings.py` service is the swap point — bge / nomic-embed locally via Ollama is the P3 path.

---

## Chunking

**Choice (P1):** Greedy fixed-size token chunks. Target 500 tokens, 50-token overlap. Tokenizer is `cl100k_base` (used by GPT-4 family + text-embedding-3-*).

**Why this size:** small enough that 5–10 chunks fit in a chat-completion context window with room for a question; big enough that one chunk usually contains a complete idea. 50-token overlap (~10%) means a sentence straddling a boundary is preserved intact in at least one chunk.

**Why tokens not characters:** the embedding model thinks in tokens. A 1000-char chunk could be 200 tokens (English) or 500 tokens (code with lots of punctuation). Token chunking gives consistent semantic density.

**Why no recursive splitter yet:** simpler is fine for the first measurement. We'll know if we need recursive splitting (paragraph → sentence → token) when we look at retrieval quality on real documents and see chunks that cut across structural boundaries.

**Open questions for P2:**
- Recursive splitting that respects markdown headings, code fences, list items.
- Adaptive chunk size by content type (code blocks need bigger windows than prose).
- "Late chunking" (embed long context, slice after) — newer technique that preserves cross-chunk attention.

---

## Index

**Choice (P1):** HNSW with `vector_cosine_ops`.

**Why:** Faster build + query than ivfflat for our scale. Cosine because we're not normalizing embeddings ourselves.

**Tradeoff:** HNSW uses more RAM than ivfflat. Not a concern until ~1M+ chunks.

---

## What gets embedded

Every node's `content` field becomes searchable, regardless of origin:

- **doc nodes**: source file → `extract_text` → chunked → embedded by `/ingest`.
- **note nodes**: typed content → chunked → embedded by `/nodes/{id}/embed` on save.
- **url nodes**: same path as notes (until P2 when we fetch + summarize the URL).

This means *every* memory ends up in the `chunks` table, behind the same `match_chunks` RPC. The chat panel doesn't know or care whether an answer came from your notes or your PDFs — it just retrieves the most relevant chunks.

**Why embed-on-save instead of background sweep:** cheap (one OpenAI call per save), immediate (search reflects reality right after Save), and idempotent (each save replaces the node's chunk set). The tradeoff is a small race window for rapid back-to-back saves, deferred to P2.

---

## Semantic edges (auto-connect v2)

The "✨ Auto-connect" button triggers `POST /workspaces/{id}/rebuild-edges` → SQL function `rebuild_semantic_edges` (migration 0005):

1. **Best-pair-chunk similarity per node-pair**: `max(1 - (chunk_a.embedding <=> chunk_b.embedding))` over all chunk pairs across A and B.
2. **kNN per node**: for each node, take top-K most-similar partners (K=3 default).
3. **Either-direction inclusion**: an edge forms if a node is in *either* party's top-K.
4. Insert `kind='semantic'` edges with `weight = similarity`. Manual edges untouched.

The 3D canvas renders semantic edges with animated purple particles. Edge `weight` modulates particle density / line opacity — strong edges are bright, weak edges fade.

**Why best-pair-chunk over node-mean.** Mean-of-chunks dilutes a long doc's content into a generic-topic vector. A 23-chunk paper's mean lives in "AI paper space" and matches nothing specifically. With best-pair-chunk, the doc connects to anything whose content matches *any one* of its chunks strongly. Long docs become first-class citizens of the graph.

**Why kNN over absolute threshold.** A single threshold can't serve all node-pair categories: short note vs short note peaks ~0.6, short note vs long-doc-mean peaks ~0.4, related entities in different sentence templates peak ~0.4. kNN per node adapts naturally — every node gets ~K of its most-similar partners regardless of absolute scale. No threshold to tune.

### Threshold tuning history (kept for the lesson)

The path to kNN went through three threshold iterations:
- `0.65` (theory): produced 0 edges. Too strict.
- `0.50`: caught only the very strongest pair (`sumit ↔ sumit's age` @ 0.617).
- `0.40`: caught related-entity pairs (`Eijuuu ↔ sumit` @ 0.427) but missed obvious things like `sumit ↔ sumit-and-books` @ 0.386 — ONE point below cutoff.

The lesson: tuning a single global threshold is a symptom of using a model that's too simple for the data. The fix isn't a better threshold; it's a different decision shape (kNN). And mean-of-chunks for long docs is structural dilution that no threshold can resolve — best-pair-chunk fixes that at the source.

**Why embedding similarity has a ceiling on short text** (still relevant): embedding-based similarity weighs surface form alongside semantic content, inseparably. Two short sentences about the same entity in different structures score lower than two unrelated short sentences in the same template. Fixes: best-pair-chunk (smaller-context-larger-overlap), hybrid retrieval (BM25 + vector), or LLM-rerank for entity resolution. We've shipped best-pair-chunk; hybrid + LLM-judge are P2/P3.

---

## Retrieval (P1)

```
query → embed → SELECT ... ORDER BY embedding <=> q LIMIT k → filter sim ≥ 0.4
```

`k = 5` for chat. After ranked retrieval we **filter by absolute similarity** ≥ 0.4. Reason: cosine-ranked top-k returns the *least bad* k chunks even when none are actually relevant ("hello" against a technical corpus). Passing low-similarity chunks to the model produces brittle "I don't have that in your memory" responses for greetings and meta-questions. With the filter, the LLM gets either confident context (→ grounded answer with citations) or empty context (→ conversational reply, no fake citations).

No reranking yet. P2 will add hybrid retrieval (vector + BM25) and a cross-encoder reranker.

**What we'll measure in P2:**
- recall@k on a hand-built golden set (20-50 Q→A pairs from real documents)
- p50 / p95 latency
- prompt-context-fit (how often does the right chunk make it into top-k?)

---

## Query rewriting (multi-turn)

Multi-turn chat introduces an asymmetry: at *generation* time we send the last 6 messages so the LLM can resolve "she", "it", "the second one" from history. But at *retrieval* time we embed the user's latest message in isolation — the embedder is blind to that same history. So `"how old is she?"` retrieves whatever embedding for that exact 4-word string happens to land near, with zero signal that "she" means a specific entity from the prior turn.

**Fix.** Before embedding, run one cheap LLM call (gpt-4o-mini, JSON mode, temp 0, max 120 tokens):

```
SYSTEM: rewrite the latest message into a standalone search query using prior turns when needed.
USER:   prior conversation: <last 4 turns>
        latest user message: how old is she?
        return JSON only.
→ {"query": "how old is Eijuuu?"}
```

Embed *that*. The user-visible question still goes into the prompt unchanged — the rewriter only steers retrieval, not generation.

**Where it runs.** `apps/api/app/services/query_rewriter.py`, called from `routers/chat.py` as Stage 0. Gated on `settings.query_rewrite_enabled` AND `len(history) > 0` — single-turn skips the call.

**A/B (20-case golden set, graph-augmented retrieval, k_max=10):**

| metric    | rewrite OFF | rewrite ON |
|-----------|-------------|------------|
| recall@1  | 80%         | **85%**    |
| recall@3  | 95%         | 95%        |
| MRR       | 0.885       | **0.910**  |

`vague-partner` flipped rank 2 → 1 (sim 0.234 → 0.552). `vague-her-age` was rank-1 already by accidental template-match but its similarity climbed 0.438 → 0.770 — same answer, much more confident.

**Defensive design.** The rewriter has three failure modes that all share one fallback: if the LLM call fails, the JSON parse fails, or the model returns the wrong shape — return the original question. Never let the rewriter break the chat path.

**Tradeoffs.**
- +1 LLM round-trip on multi-turn turns (~300-1500ms latency, ~$0.0001).
- Skipped on single-turn (zero added cost — the dominant case).
- Could be parallelized with embed-of-original as a hedge, or gated on a pronoun heuristic at scale. Not yet needed.

---

## Prompt assembly

**Pattern:**
```
[system: you are Mem Palace; cite source nodes by title]
[context: top-k chunks joined with separators + source node titles]
[user: question]
```

Keep it boring. Fancier templating waits for a measurable need.

---

## Streaming

OpenAI chat completions with `stream=True`. FastAPI yields `data: <token>\n\n` SSE frames. The browser's `EventSource` handles reconnection automatically.

**Edge case:** if retrieval fails or yields zero hits, we must still respond — currently we'll send a special "no_context" event so the UI can render a clear empty state. Implement in step 9.

---

## Observability (deferred to P4)

We'll instrument the retrieval and chat paths with OpenTelemetry, forward to Langfuse or Phoenix. Trace key spans: `embed`, `retrieve`, `prompt_build`, `llm_stream`. Tag with question, top-k node ids, latency, token usage.

---

## Evals (deferred to P4)

Minimum viable eval rig:
- Golden set: 30 Q→A pairs with cited source nodes.
- Metrics: recall@5, faithfulness (LLM-as-judge: does the answer use only cited context?), answer relevance.
- Frequency: run on every PR that touches retrieval, chunking, or prompt assembly.
