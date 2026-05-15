"""Topic clustering service — Phase 1 scalable substrate (ADR-019).

Two stages, deliberately split:

  Stage 1 — sklearn MiniBatchKMeans (deterministic, math).
    Embeddings already encode "is this about the same thing?" — that is
    exactly what they are for. K-means on those is the textbook
    semantic-clustering recipe. MiniBatchKMeans (vs full KMeans) trades
    ~2% quality for ~10-100× speed; standard for production-scale topic
    work.

  Stage 2 — LLM naming (one cheap call per *changed* cluster).
    Given the member titles for a cluster, ask gpt-4o-mini for a short
    topic label. JSON-mode output, temp 0, max ~30 tokens. Defensive parse
    with a fallback to "Topic N" if the model misbehaves.

    A `members_hash` is computed per cluster (sha256 of sorted member ids).
    The endpoint reuses the existing label when the hash matches an old
    cluster — saves ~$0.0001 per unchanged cluster per recompute, which
    in steady state is most of them.

K selection:
  Silhouette score across K ∈ [2..min(MAX_K_ABS, n // 3)] with
  `sklearn.metrics.silhouette_score(sample_size=...)` to keep the
  evaluation sub-quadratic. Subsampling drops accuracy ~5% but turns
  100k-node O(n²) into O(n × sample_size).

Scaling characteristics (ADR-019):
  n=14   → <100ms total (today's user)
  n=1k   → ~500ms
  n=10k  → ~5s
  n=100k → ~30s, possibly worth moving to a background task (P3).
"""

from __future__ import annotations

import hashlib
import json
import time
from dataclasses import dataclass

import numpy as np
from openai import AsyncOpenAI
from sklearn.cluster import MiniBatchKMeans
from sklearn.metrics import silhouette_score

from ..config import settings

# Don't try to cluster fewer than this — silhouette is meaningless and the
# UX of "1 cluster" is worse than no clustering.
MIN_NODES_FOR_KMEANS = 6

# Cap K at this fraction of n (e.g. n=14 → max K of ~4). Avoids the
# degenerate "every node its own cluster" case that maximizes silhouette
# trivially.
MAX_K_FRACTION = 1 / 3
MAX_K_ABS = 12

# MiniBatchKMeans hyperparams. n_init=10 → 10 random restarts; sklearn
# keeps the best inertia. batch_size auto-scales with n inside MBK; we
# leave the default (1024).
KMEANS_N_INIT = 10
KMEANS_MAX_ITER = 100

# Silhouette sub-sample cap. Beyond this many points the O(n²) silhouette
# computation gets slow. Sub-sampling preserves the *ranking* of K
# candidates (which is all we use silhouette for) while bounding cost.
SILHOUETTE_SAMPLE_MAX = 1000


NAME_SYSTEM_PROMPT = """You name a cluster of related memory notes.

You receive a list of note titles that an embedding-based clustering algorithm grouped together. Return ONE short topic label (2-3 words) that captures what the cluster is about.

Rules:
- Be specific, not generic. "Personal info" is OK; "Notes" is not.
- 2-3 words MAX. Title-case if it reads naturally.
- Output ONLY a JSON object: {"label": "..."}. No prose, no markdown.
""".strip()


@dataclass
class Cluster:
    label: str
    member_ids: list[str]
    members_hash: str             # sha256 of sorted member ids
    naming_skipped: bool = False  # True when label was reused from previous run


@dataclass
class ClusteringResult:
    clusters: list[Cluster]
    k_chosen: int | None          # None when corpus too small
    silhouette: float | None      # None when k=1 fallback
    naming_tokens_in: int = 0
    naming_tokens_out: int = 0
    naming_ms: int = 0
    naming_calls: int = 0         # number of LLM calls actually made (after reuse)


# ---------------------------------------------------------------------------
# Membership hashing
# ---------------------------------------------------------------------------


def hash_members(member_ids: list[str]) -> str:
    """Deterministic fingerprint of a cluster's membership.

    Sort first so order doesn't matter. NUL-separator avoids any
    "member_a + member_b" / "member_ab + ''" collision.
    """
    joined = "\0".join(sorted(member_ids)).encode("utf-8")
    return hashlib.sha256(joined).hexdigest()


# ---------------------------------------------------------------------------
# K-means + K selection
# ---------------------------------------------------------------------------


def _pick_best_k(points: np.ndarray) -> tuple[int, np.ndarray, float]:
    """Try each candidate K, pick by silhouette. Returns (k, assignments, score).

    Sub-samples the silhouette computation when the corpus is large enough
    that O(n²) hurts. The K *ranking* is preserved by sub-sampling — we
    only lose absolute-score precision, which we don't use.
    """
    n = points.shape[0]
    max_k = min(MAX_K_ABS, max(2, int(n * MAX_K_FRACTION)))
    sample_size = min(n, SILHOUETTE_SAMPLE_MAX) if n > 100 else None

    best: tuple[float, int, np.ndarray] | None = None
    for k in range(2, max_k + 1):
        # MiniBatchKMeans is order-of-magnitude faster than full KMeans
        # at scale and within ~2% quality. Production-standard.
        model = MiniBatchKMeans(
            n_clusters=k,
            n_init=KMEANS_N_INIT,
            max_iter=KMEANS_MAX_ITER,
            random_state=42,           # deterministic across runs
            batch_size=min(1024, n),
        )
        labels = model.fit_predict(points)

        # Silhouette is undefined if a candidate K produced fewer
        # populated clusters than requested (rare with k-means++ init,
        # but possible on degenerate data). Treat as "skip this K".
        if len(set(labels.tolist())) < 2:
            continue
        try:
            score = float(
                silhouette_score(
                    points,
                    labels,
                    sample_size=sample_size,
                    random_state=42,
                )
            )
        except ValueError:
            # All points in same cluster → silhouette undefined.
            continue

        if best is None or score > best[0]:
            best = (score, k, labels)

    if best is None:
        # Edge case: nothing scored. Fall back to a single cluster.
        return 1, np.zeros(n, dtype=int), 0.0
    return best[1], best[2], best[0]


# ---------------------------------------------------------------------------
# LLM naming
# ---------------------------------------------------------------------------


def _parse_label(raw: str, fallback: str) -> str:
    if not raw:
        return fallback
    text = raw.strip()
    if text.startswith("```"):
        text = text.strip("`")
        if text.lower().startswith("json"):
            text = text[4:]
        text = text.strip()
    try:
        obj = json.loads(text)
        label = obj.get("label")
        if isinstance(label, str) and label.strip():
            # Cap length defensively in case the model ignored the rule.
            return label.strip()[:40]
    except (ValueError, TypeError):
        pass
    return fallback


async def _name_cluster(
    openai: AsyncOpenAI,
    titles: list[str],
    fallback: str,
) -> tuple[str, int, int]:
    """Ask gpt-4o-mini to label a cluster. Returns (label, in_tokens, out_tokens)."""
    titles_block = "\n".join(f"- {t}" for t in titles[:20])  # cap input size
    user = f"Notes in this cluster:\n{titles_block}\n\nReturn JSON only."
    try:
        resp = await openai.chat.completions.create(
            model=settings.openai_chat_model,
            messages=[
                {"role": "system", "content": NAME_SYSTEM_PROMPT},
                {"role": "user", "content": user},
            ],
            temperature=0.0,
            response_format={"type": "json_object"},
            max_tokens=30,
        )
        in_tok = resp.usage.prompt_tokens if resp.usage else 0
        out_tok = resp.usage.completion_tokens if resp.usage else 0
        raw = resp.choices[0].message.content if resp.choices else ""
        return _parse_label(raw or "", fallback), in_tok, out_tok
    except Exception:
        return fallback, 0, 0


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------


async def cluster_workspace(
    openai: AsyncOpenAI,
    embeddings_by_node: dict[str, list[float]],
    titles_by_node: dict[str, str],
    previous_label_by_hash: dict[str, str] | None = None,
) -> ClusteringResult:
    """Cluster a workspace's nodes by topic.

    Args:
        embeddings_by_node: map node_id → mean embedding vector
        titles_by_node: map node_id → display title (for LLM naming)
        previous_label_by_hash: from the prior recompute, map members_hash
            → label. When a new cluster's hash matches one in this map,
            we skip the LLM call and reuse the label. Pass None on first
            run for this workspace.

    Returns a ClusteringResult. When the corpus is too small (<6 nodes) we
    return a single "All notes" cluster — refusing to invent topics from
    insufficient signal is honest behavior.
    """
    previous_label_by_hash = previous_label_by_hash or {}

    node_ids = list(embeddings_by_node.keys())
    if len(node_ids) < MIN_NODES_FOR_KMEANS:
        h = hash_members(node_ids)
        return ClusteringResult(
            clusters=[
                Cluster(
                    label=previous_label_by_hash.get(h, "All notes"),
                    member_ids=node_ids,
                    members_hash=h,
                    naming_skipped=h in previous_label_by_hash,
                )
            ],
            k_chosen=None,
            silhouette=None,
        )

    # Build the embedding matrix in the same order as node_ids.
    points = np.asarray(
        [embeddings_by_node[nid] for nid in node_ids], dtype=np.float32
    )
    k, assignments, sil = _pick_best_k(points)

    by_cluster: dict[int, list[str]] = {}
    for nid, a in zip(node_ids, assignments.tolist()):
        by_cluster.setdefault(a, []).append(nid)

    # Name each cluster — reusing the previous label when membership unchanged.
    t0 = time.perf_counter()
    in_tot = 0
    out_tot = 0
    calls = 0
    clusters: list[Cluster] = []
    for ci, member_ids in by_cluster.items():
        h = hash_members(member_ids)
        prior = previous_label_by_hash.get(h)
        if prior is not None:
            clusters.append(
                Cluster(
                    label=prior,
                    member_ids=member_ids,
                    members_hash=h,
                    naming_skipped=True,
                )
            )
            continue

        titles = [
            titles_by_node.get(nid, "(untitled)") or "(untitled)"
            for nid in member_ids
        ]
        label, in_tok, out_tok = await _name_cluster(
            openai, titles, fallback=f"Topic {ci + 1}"
        )
        in_tot += in_tok
        out_tot += out_tok
        calls += 1
        clusters.append(
            Cluster(
                label=label,
                member_ids=member_ids,
                members_hash=h,
                naming_skipped=False,
            )
        )
    naming_ms = int((time.perf_counter() - t0) * 1000)

    # Stable order: largest first, then by label.
    clusters.sort(key=lambda c: (-len(c.member_ids), c.label))

    return ClusteringResult(
        clusters=clusters,
        k_chosen=k,
        silhouette=sil,
        naming_tokens_in=in_tot,
        naming_tokens_out=out_tot,
        naming_ms=naming_ms,
        naming_calls=calls,
    )
