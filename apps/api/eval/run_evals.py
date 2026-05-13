#!/usr/bin/env python3
"""Mem Palace retrieval evaluation runner.

For each case in golden.json:
  1. embed the question via OpenAI (same model the app uses)
  2. call the match_chunks RPC (same RPC the app's /chat uses)
  3. map returned chunks to their node titles, deduped, in rank order
  4. find the first rank where any expected_node_title appears

Aggregates over all cases:
  - recall@1, recall@3, recall@5, recall@10
  - MRR (Mean Reciprocal Rank)
  - per-case rank + similarity of the chosen result
  - failure list (cases that miss at recall@5)

Direct DB access via SUPABASE_SERVICE_ROLE_KEY — we are testing the
retrieval layer in isolation, not the API/auth layers. The result tells
you "is the chunk store + vector index returning what it should."

Pure stdlib: no external Python deps required. Reads SUPABASE_URL,
SUPABASE_SERVICE_ROLE_KEY, OPENAI_API_KEY, OPENAI_EMBEDDING_MODEL from
the repo's .env file.

Run from anywhere:
    python3 apps/api/eval/run_evals.py
or:
    make evals
"""

from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

# ---------------------------------------------------------------------------
# Env loader (no python-dotenv dep)
# ---------------------------------------------------------------------------

REPO_ROOT = Path(__file__).resolve().parents[3]
ENV_FILE = REPO_ROOT / ".env"


def load_env() -> dict[str, str]:
    if not ENV_FILE.exists():
        sys.stderr.write(f"FATAL: missing {ENV_FILE}\n")
        sys.exit(2)
    out: dict[str, str] = {}
    for raw in ENV_FILE.read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, _, v = line.partition("=")
        out[k.strip()] = v.strip()
    return out


ENV = load_env()
SUPABASE_URL = ENV.get("SUPABASE_URL", "").rstrip("/")
SERVICE_KEY = ENV.get("SUPABASE_SERVICE_ROLE_KEY", "")
OPENAI_KEY = ENV.get("OPENAI_API_KEY", "")
EMBED_MODEL = ENV.get("OPENAI_EMBEDDING_MODEL", "text-embedding-3-small")

for name, val in (
    ("SUPABASE_URL", SUPABASE_URL),
    ("SUPABASE_SERVICE_ROLE_KEY", SERVICE_KEY),
    ("OPENAI_API_KEY", OPENAI_KEY),
):
    if not val:
        sys.stderr.write(f"FATAL: {name} not set in .env\n")
        sys.exit(2)


# ---------------------------------------------------------------------------
# HTTP helpers (no requests / httpx dep)
# ---------------------------------------------------------------------------


def _do_request(req: urllib.request.Request) -> Any:
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"HTTP {e.code}: {body}") from e


def post_json(url: str, payload: dict, headers: dict[str, str]) -> Any:
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={**headers, "Content-Type": "application/json"},
        method="POST",
    )
    return _do_request(req)


def get_json(url: str, headers: dict[str, str]) -> Any:
    req = urllib.request.Request(url, headers=headers, method="GET")
    return _do_request(req)


# ---------------------------------------------------------------------------
# Retrieval primitives
# ---------------------------------------------------------------------------


def embed(question: str) -> list[float]:
    resp = post_json(
        "https://api.openai.com/v1/embeddings",
        {"model": EMBED_MODEL, "input": [question]},
        {"Authorization": f"Bearer {OPENAI_KEY}"},
    )
    return resp["data"][0]["embedding"]


def search_chunks(query_vec: list[float], k: int) -> list[dict]:
    return post_json(
        f"{SUPABASE_URL}/rest/v1/rpc/match_chunks",
        {"query_embedding": query_vec, "match_count": k},
        {"apikey": SERVICE_KEY, "Authorization": f"Bearer {SERVICE_KEY}"},
    )


def fetch_node_titles() -> dict[str, str]:
    rows = get_json(
        f"{SUPABASE_URL}/rest/v1/nodes?select=id,title",
        {"apikey": SERVICE_KEY, "Authorization": f"Bearer {SERVICE_KEY}"},
    )
    return {r["id"]: (r.get("title") or "(untitled)").strip() for r in rows}


# ---------------------------------------------------------------------------
# Eval runner
# ---------------------------------------------------------------------------


def run_case(case: dict, k_max: int, titles: dict[str, str]) -> dict:
    """Run a single eval case. Returns a dict with rank info + ranked titles."""
    q = case["question"]
    expected = {t.strip() for t in case["expected_node_titles"]}
    t0 = time.perf_counter()

    qvec = embed(q)
    chunks = search_chunks(qvec, k_max)

    # Build ranked list of unique node titles (preserving rank order).
    ranked_titles: list[tuple[str, float | None]] = []
    seen_ids: set[str] = set()
    for c in chunks:
        nid = c.get("node_id")
        if not nid or nid in seen_ids:
            continue
        seen_ids.add(nid)
        title = titles.get(nid, "(unknown)")
        ranked_titles.append((title, c.get("similarity")))

    # Find first rank where an expected title appears.
    rank: int | None = None
    matched_title: str | None = None
    for i, (title, _) in enumerate(ranked_titles, start=1):
        if title in expected:
            rank = i
            matched_title = title
            break

    elapsed_ms = int((time.perf_counter() - t0) * 1000)

    return {
        "id": case["id"],
        "question": q,
        "expected": sorted(expected),
        "ranked_titles": ranked_titles,
        "rank": rank,
        "matched_title": matched_title,
        "elapsed_ms": elapsed_ms,
    }


def main() -> int:
    golden_path = Path(__file__).parent / "golden.json"
    if not golden_path.exists():
        sys.stderr.write(f"FATAL: missing {golden_path}\n")
        return 2

    golden = json.loads(golden_path.read_text())
    cases = golden.get("cases", [])
    k_max = int(golden.get("k_max", 10))

    if not cases:
        print("No cases in golden.json — nothing to evaluate.")
        return 0

    print(f"== Mem Palace retrieval evals ==")
    print(f"   {len(cases)} cases · k_max={k_max} · model={EMBED_MODEL}")
    print()

    titles = fetch_node_titles()
    if not titles:
        print("No nodes in DB. Add notes/docs and re-run.")
        return 0

    # Warn if expected titles don't exist in current DB
    db_title_set = set(titles.values())
    for case in cases:
        missing = [
            t for t in case["expected_node_titles"] if t.strip() not in db_title_set
        ]
        if missing:
            print(
                f"  ⚠  case '{case['id']}': expected title(s) not in DB: {missing}"
            )

    print()
    results = []
    for case in cases:
        try:
            r = run_case(case, k_max, titles)
            results.append(r)
        except Exception as e:
            print(f"  ✗ {case['id']}: error: {e}")

    # Per-case table
    print(f"{'case':28} {'rank':>5}  {'sim':>6}  {'time':>6}  question")
    print("-" * 100)
    for r in results:
        rank_str = str(r["rank"]) if r["rank"] is not None else "miss"
        sim_val = next(
            (s for t, s in r["ranked_titles"] if t == r["matched_title"]), None
        )
        sim_str = f"{sim_val:.3f}" if isinstance(sim_val, (int, float)) else "  -"
        print(
            f"{r['id'][:28]:28} {rank_str:>5}  {sim_str:>6}  "
            f"{r['elapsed_ms']:>4}ms  {r['question']}"
        )

    # Aggregates
    n = len(results)
    if n == 0:
        return 0

    def recall_at(k: int) -> float:
        return sum(1 for r in results if r["rank"] is not None and r["rank"] <= k) / n

    mrr = sum(1 / r["rank"] for r in results if r["rank"] is not None) / n

    print()
    print(f"== Aggregates over {n} case(s) ==")
    print(f"   recall@1   {recall_at(1):>6.2%}")
    print(f"   recall@3   {recall_at(3):>6.2%}")
    print(f"   recall@5   {recall_at(5):>6.2%}")
    print(f"   recall@10  {recall_at(10):>6.2%}")
    print(f"   MRR        {mrr:>6.3f}")

    # Failure analysis
    failures = [r for r in results if r["rank"] is None or r["rank"] > 5]
    if failures:
        print()
        print(f"== Failures (recall@5) ==")
        for r in failures:
            print(f"  ✗ {r['id']}: {r['question']!r}")
            print(f"    expected: {r['expected']}")
            top5 = [
                f"{t} ({s:.2f})" if isinstance(s, (int, float)) else t
                for t, s in r["ranked_titles"][:5]
            ]
            print(f"    top-5 nodes: {top5}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
