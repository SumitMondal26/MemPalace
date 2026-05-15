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

## Switching retrieval strategies (A/B comparison)

Every retrieval-touching feature added an env flag. Same script, same golden set, one flag changed at a time. Numbers go in the commit message.

```bash
# Baseline: pure vector search (default)
make evals

# Graph-augmented: vector search + 1-hop neighborhood expansion
EVAL_STRATEGY=match_chunks_with_neighbors make evals

# + LLM query rewriting on cases that carry a `history` field in golden.json
EVAL_QUERY_REWRITE=1 EVAL_STRATEGY=match_chunks_with_neighbors make evals

# + LLM-as-judge reranker (over-fetch 2× from retrieval, re-order top-N → top-K)
EVAL_RERANK=1 EVAL_STRATEGY=match_chunks_with_neighbors make evals

# Full stack — current best
EVAL_QUERY_REWRITE=1 EVAL_RERANK=1 EVAL_STRATEGY=match_chunks_with_neighbors make evals

# Stress test: only top-1 chunk allowed. Reveals graph-aug's recall lift starkly.
EVAL_K_MAX=1 EVAL_STRATEGY=match_chunks_with_neighbors make evals
```

This lets you measure any retrieval change against the same golden set. Workflow:

1. Run baseline → write down numbers.
2. Change retrieval (new strategy / new SQL / new threshold / new flag).
3. Run with the new strategy → compare numbers.
4. Keep or revert based on what the metrics say.

### Measured deltas (21-case golden set)

The cumulative story we shipped through P2:

| Configuration | recall@1 | recall@3 | recall@5 | MRR |
|---|---|---|---|---|
| `match_chunks` (vector only, baseline) | ~75% | ~90% | ~95% | ~0.83 |
| `match_chunks_with_neighbors` (graph-aug) | 80% | 95% | 100% | 0.885 |
| `+ EVAL_QUERY_REWRITE=1` (rewriter on multi-turn) | 85% | 95% | 100% | 0.910 |
| `+ EVAL_RERANK=1` (rerank on top of rewriter) | **95.24%** | **100%** | 100% | **0.976** |

Graph-aug bought us recall (right chunk shows up *somewhere*). Rewriter bought us recall on multi-turn pronouns (right chunk for follow-up questions). Reranker bought us precision (right chunk lands at *position 1*). Each layer addressed a distinct failure mode — measured, not guessed.

The eval script header tells you what's in effect:

```
== Mem Palace retrieval evals ==
   21 cases · k_max=10 · model=text-embedding-3-small · strategy=match_chunks_with_neighbors (neighbor_count=1) · query_rewrite=ON · rerank=ON (chat_model=gpt-4o-mini)
```

---

## Limitations and what's next

These evals measure **retrieval recall only**. They do *not* measure:

- **Faithfulness** — does the answer actually use the retrieved context, or hallucinate? Visible in `/insights` per-row, not yet automated. (P4: LLM-as-judge over answer + context.)
- **Answer quality** — does the answer correctly use the chunk? Same path: P4 LLM-as-judge.
- **Agent path quality** — `/agent` (P3.1) makes multiple retrievals per question; `make evals` only measures single-shot recall. The agent's *tool calls* use the same retrieval primitives we measure here, so retrieval improvements propagate; what we don't yet measure is whether the agent *picks the right tools in the right order*.
- **Latency under load** — single-shot timings only.
- **Cross-tenant isolation** — eval uses service role and ignores RLS. (Add focused RLS tests if we touch the security layer.)

Each is a future line item — but recall@k + MRR is the foundation, and we add a measurement *before* any retrieval optimization.

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
