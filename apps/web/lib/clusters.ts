/**
 * Lightweight cluster-by-connected-components over the semantic graph.
 *
 * Why this approach (not k-means, not LLM-labeled topics):
 *  - The auto-connect pipeline (best-pair-chunk + kNN + min-weight floor)
 *    already encodes "these nodes are semantically related" as edge weights.
 *    Connected components on a weight-thresholded subgraph just *reads* that
 *    structure — no new embeddings, no new endpoint, no LLM cost.
 *  - Manual edges are intentionally excluded from clustering. The user
 *    drew them for their own reasons; they shouldn't force topological
 *    grouping. Only auto-discovered semantic structure clusters.
 *  - Edges with weight < MIN_WEIGHT are dropped before clustering. This
 *    prevents a single weak link between two distinct topics from merging
 *    them into one giant blob. 0.40 = the existing "medium" tier floor in
 *    edgeTiers.ts, so the threshold story stays consistent across the UI.
 *
 * What it gives you:
 *  - Deterministic cluster IDs (smallest member ID wins → stable across
 *    renders).
 *  - A color per cluster, drawn from a palette wide enough for ~20 clusters
 *    before colors start repeating.
 *  - Singletons (orphans + nodes with only weak edges) get cluster_id = null
 *    and render in the existing type-color, so the rest of the UI degrades
 *    gracefully.
 */

import type { DbCluster, DbEdge, DbNode } from "./db";

/** Minimum edge weight to count as a clustering link. Mirrors edgeTiers.medium. */
export const CLUSTER_MIN_WEIGHT = 0.6;

/** Minimum members for a connected component to count as a "cluster." */
export const CLUSTER_MIN_SIZE = 2;

/**
 * Distinct, color-blind-leaning palette. Picked for visibility on the dark
 * canvas background. First entry intentionally ≠ any of the type colors so
 * cluster colors don't masquerade as type colors.
 */
const CLUSTER_PALETTE = [
  "#f87171", // red-400
  "#34d399", // emerald-400
  "#facc15", // yellow-400
  "#60a5fa", // blue-400
  "#a78bfa", // violet-400
  "#fb923c", // orange-400
  "#22d3ee", // cyan-400 (last resort — collides with note type color)
  "#f472b6", // pink-400 (last resort — collides with url type color)
];

export type Cluster = {
  /** Stable ID — smallest member node id (lex-sorted) — same across renders. */
  id: string;
  color: string;
  members: string[]; // node IDs
  /** Best label we can derive without LLM help: shortest distinct title prefix. */
  label: string;
};

export type ClusterIndex = {
  /** Map nodeId → cluster the node belongs to (null for singletons). */
  byNode: Map<string, Cluster | null>;
  /** All clusters sorted by descending size, palette colors already assigned. */
  clusters: Cluster[];
};

/**
 * Build the cluster index for the current graph snapshot.
 *
 * Algorithm:
 *  1. Build adjacency over `kind === 'semantic' && weight >= MIN_WEIGHT`.
 *  2. BFS from every unvisited node → connected components.
 *  3. Components of size < CLUSTER_MIN_SIZE are dropped (their members get null).
 *  4. Sort components by size (desc) then by id (asc, deterministic).
 *  5. Assign palette colors in that order. Recycle if more clusters than palette.
 */
export function buildClusters(nodes: DbNode[], edges: DbEdge[]): ClusterIndex {
  const adj = new Map<string, Set<string>>();
  for (const n of nodes) adj.set(n.id, new Set());
  for (const e of edges) {
    if (e.kind !== "semantic") continue;
    if ((e.weight ?? 0) < CLUSTER_MIN_WEIGHT) continue;
    adj.get(e.source_id)?.add(e.target_id);
    adj.get(e.target_id)?.add(e.source_id);
  }

  const seen = new Set<string>();
  const components: string[][] = [];
  for (const n of nodes) {
    if (seen.has(n.id)) continue;
    const queue = [n.id];
    const comp: string[] = [];
    while (queue.length) {
      const cur = queue.shift()!;
      if (seen.has(cur)) continue;
      seen.add(cur);
      comp.push(cur);
      for (const nb of adj.get(cur) ?? []) {
        if (!seen.has(nb)) queue.push(nb);
      }
    }
    components.push(comp);
  }

  // Build cluster objects only for components meeting the size threshold.
  const titleByNode = new Map(nodes.map((n) => [n.id, (n.title ?? "").trim()]));
  const real = components
    .filter((c) => c.length >= CLUSTER_MIN_SIZE)
    .map<Cluster>((memberIds) => {
      const sortedMembers = [...memberIds].sort();
      return {
        id: sortedMembers[0],
        color: "", // assigned below after sorting
        members: sortedMembers,
        label: deriveLabel(sortedMembers, titleByNode),
      };
    })
    .sort((a, b) =>
      b.members.length - a.members.length || a.id.localeCompare(b.id),
    );

  real.forEach((c, i) => {
    c.color = CLUSTER_PALETTE[i % CLUSTER_PALETTE.length];
  });

  const byNode = new Map<string, Cluster | null>();
  for (const n of nodes) byNode.set(n.id, null);
  for (const c of real) {
    for (const id of c.members) byNode.set(id, c);
  }

  return { byNode, clusters: real };
}

/**
 * Adapter: turn DB-persisted clusters (workspaces.recompute-clusters output)
 * into the same ClusterIndex shape the canvas already consumes.
 *
 * Why same shape: the canvas (color-by-cluster, hover label "cluster: X",
 * legend) doesn't care whether the grouping came from connected components
 * or k-means + LLM-naming. One renderer, two sources.
 *
 * Sort order matches buildClusters (size desc, id asc) so palette colors
 * map consistently regardless of which builder ran.
 */
export function buildClusterIndexFromDb(
  nodes: DbNode[],
  dbClusters: DbCluster[],
): ClusterIndex {
  // Group node ids by their cluster_id.
  const membersByCluster = new Map<string, string[]>();
  for (const n of nodes) {
    if (!n.cluster_id) continue;
    const list = membersByCluster.get(n.cluster_id) ?? [];
    list.push(n.id);
    membersByCluster.set(n.cluster_id, list);
  }

  // Build Cluster objects in the canonical sort order.
  const clusters = dbClusters
    .map<Cluster>((c) => {
      const members = (membersByCluster.get(c.id) ?? []).slice().sort();
      return {
        id: c.id,
        color: "", // assigned below
        members,
        label: c.label,
      };
    })
    // Drop empty clusters (every member could have been deleted since recompute).
    .filter((c) => c.members.length >= CLUSTER_MIN_SIZE)
    .sort((a, b) =>
      b.members.length - a.members.length || a.id.localeCompare(b.id),
    );

  clusters.forEach((c, i) => {
    c.color = CLUSTER_PALETTE[i % CLUSTER_PALETTE.length];
  });

  const byNode = new Map<string, Cluster | null>();
  for (const n of nodes) byNode.set(n.id, null);
  for (const c of clusters) {
    for (const id of c.members) byNode.set(id, c);
  }
  return { byNode, clusters };
}

/**
 * Cheap label heuristic: use the most-common first word across member titles.
 * Falls back to "<count> nodes" when titles share nothing in common.
 *
 * This is intentionally simple — a real LLM-named cluster ("Personal info",
 * "AI papers") needs an extra OpenAI call and a place to persist the name.
 * Deferred to a follow-up. Today's version is "good enough that the user
 * can tell what each color means."
 */
function deriveLabel(memberIds: string[], titles: Map<string, string>): string {
  const counts = new Map<string, number>();
  for (const id of memberIds) {
    const t = titles.get(id) ?? "";
    const firstWord = t.split(/\s+/)[0]?.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (!firstWord) continue;
    counts.set(firstWord, (counts.get(firstWord) ?? 0) + 1);
  }
  // pick word that appears in >= half the cluster
  const half = memberIds.length / 2;
  let best: { word: string; count: number } | null = null;
  for (const [word, count] of counts) {
    if (count < half) continue;
    if (!best || count > best.count) best = { word, count };
  }
  if (best) return `${best.word} (${memberIds.length})`;
  return `${memberIds.length} nodes`;
}
