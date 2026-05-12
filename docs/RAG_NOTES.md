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

## Retrieval (P1, naive)

```
query → embed → SELECT ... ORDER BY embedding <=> q LIMIT k
```

`k = 5` for chat. No filtering, no reranking yet. This is the baseline.

**What we'll measure in P2:**
- recall@k on a hand-built golden set (20-50 Q→A pairs from real documents)
- p50 / p95 latency
- prompt-context-fit (how often does the right chunk make it into top-k?)

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
