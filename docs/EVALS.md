# Retrieval Evals

Quantifies how well our RAG retrieval finds the right chunks for known questions.
Without numbers, every retrieval change is religion. With numbers, every change is
engineering.

## Run it

```bash
make evals
```

Or directly:

```bash
python3 apps/api/eval/run_evals.py
```

Pure-stdlib Python — no extra deps. Reads `.env` from the repo root for
`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `OPENAI_API_KEY`, and
`OPENAI_EMBEDDING_MODEL`.

## What it measures

For each case in `apps/api/eval/golden.json`:

1. Embed the question with the same OpenAI model the app uses.
2. Call the `match_chunks` RPC (same one `/chat` uses).
3. Map returned chunks → their node titles, deduped, in rank order.
4. Find the first rank where any of the case's `expected_node_titles` appears.

Aggregates:

| Metric | Meaning |
|---|---|
| **recall@k** | Fraction of cases where an expected node showed up in top-k results. recall@5 = 80% means 4/5 of your test questions had the right answer in the first 5 hits. |
| **MRR** (Mean Reciprocal Rank) | Average of `1/rank` over all cases. Penalizes retrieval that finds the right node but ranks it low. MRR = 1.0 means every answer is rank 1; MRR = 0.5 means the average is rank 2. |

A failure list at the bottom shows cases that missed recall@5, with the actual top-5 node titles for each, so you can spot patterns.

## Why this design

- **Standalone script, not an API endpoint.** Evals run *against* the retrieval layer, not through the auth layer. No JWTs, no preflight, no FastAPI startup. Simpler.
- **Direct service-role DB access.** Bypasses RLS for the eval — we're testing the chunk store, not workspace isolation. Workspace isolation has its own tests (or will).
- **JSON golden set, not YAML or SQL.** Easy to hand-edit, easy to diff in PR, easy to extend with metadata (notes, tags, difficulty).
- **No per-case expected similarity threshold yet.** P1 measures *did the right node show up*, not *with what confidence*. Add similarity-floor checks in P2 if needed.

## How to add a case

Open `apps/api/eval/golden.json` and append:

```json
{
  "id": "topic-something",
  "question": "the question a user might ask",
  "expected_node_titles": ["title-of-the-node-that-should-be-retrieved"],
  "notes": "optional — what this case tests"
}
```

Conventions:
- **id** is a kebab-case slug. Group with prefixes: `personal-`, `paper-`, `code-`, etc.
- **expected_node_titles** is a list — multiple acceptable nodes. The case passes if *any* of them is in top-k.
- **question** should be in the user's natural voice, not engineered to match.

Aim for 20-30 cases over time, covering:
- Direct lookups ("what is my name?")
- Concept questions ("how does X work?")
- Multi-hop relationships ("how is X related to Y?")
- Easy and hard cases (mix is signal — you want some misses to learn from)

## How to use the numbers

**Before you change retrieval:** run evals, write down the numbers.

**After you change retrieval:** run evals, compare. Three outcomes:

1. **Numbers improved →** keep the change, document the gain in commit message + DECISIONS.md.
2. **Numbers unchanged →** the change is cosmetic; consider whether it's worth the complexity.
3. **Numbers regressed →** revert, dig into specific failures, learn before trying again.

This is the discipline that distinguishes RAG engineering from RAG vibes.

## Limitations and what's next

P1 evals measure **retrieval recall only**. They do *not* measure:

- **Faithfulness** — does the answer actually use the retrieved context, or hallucinate? (P3: LLM-as-judge.)
- **Answer quality** — does the answer correctly use the chunk? (P3: LLM-as-judge.)
- **Latency under load** — single-shot timings only. (P4 if needed.)
- **Cross-tenant isolation** — eval uses service role and ignores RLS. (Add focused RLS tests in P2 if we touch the security layer.)

Each metric is a future line item — but recall@k + MRR is the foundation, and you should add it before *any* retrieval optimization.

## Reading the failure list

When a case fails recall@5, the script prints:

```
✗ paper-multi-head-attention: 'what is multi-head attention?'
  expected: ['book']
  top-5 nodes: ['book (0.42)', 'sumit (0.18)', 'sumit's age (0.15)', ...]
```

Things to learn from a failure:

- **Expected made it into top-N but not top-5** → retrieval is close, threshold tuning or reranker may help.
- **Expected nowhere in top-N** → retrieval is missing — either the chunk isn't well-embedded for this question phrasing, or it doesn't exist (re-ingest), or the question needs rewriting.
- **Wrong node has high similarity** → false friend. Suggests need for hybrid retrieval (BM25 alongside vector) or reranker.

## What evals unlock for our project

The next two retrieval upgrades — **graph-augmented retrieval (neighborhood expansion)** and **best-pair-chunk for long docs** — both become measurable rather than guessed:

```
make evals  # baseline numbers (today)
# implement neighborhood expansion
make evals  # post-change numbers
# diff the recall@5 column → keep or revert
```

That's the loop. Build it once, use it forever.
