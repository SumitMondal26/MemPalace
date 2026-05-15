/**
 * Zustand store — the server-mirror state for the graph canvas.
 *
 * What lives here:
 *   - workspaceId (set on first render, never changes in P1)
 *   - nodes / edges (mirrors of DB rows)
 *   - selectedNodeId (UI state — which sidebar to show)
 *
 * What does NOT live here:
 *   - Mid-drag node positions (React Flow owns those, commit on drag stop)
 *   - Chat messages (separate concern; will live in its own slice in step 9)
 */

import { create } from "zustand";
import type { DbCluster, DbEdge, DbNode, NodeType } from "./db";

type State = {
  workspaceId: string | null;
  nodes: DbNode[];
  edges: DbEdge[];
  /** LLM-named topic clusters from the recompute-clusters endpoint. Empty
   *  when the workspace has never been clustered — the GraphCanvas falls
   *  back to connected-components in that case. */
  dbClusters: DbCluster[];
  selectedNodeId: string | null;
  /** When set, the sidebar renders a new-node form for this type. */
  draftType: NodeType | null;
};

type Actions = {
  setInitial: (s: {
    workspaceId: string;
    nodes: DbNode[];
    edges: DbEdge[];
    dbClusters?: DbCluster[];
  }) => void;
  upsertNode: (n: DbNode) => void;
  removeNode: (id: string) => void;
  upsertEdge: (e: DbEdge) => void;
  removeEdge: (id: string) => void;
  setEdges: (edges: DbEdge[]) => void;
  setDbClusters: (clusters: DbCluster[]) => void;
  /** After recompute-clusters runs, refresh nodes (cluster_id changed) +
   *  clusters in one atomic store write so the canvas re-renders consistently. */
  applyClusters: (nodes: DbNode[], clusters: DbCluster[]) => void;
  selectNode: (id: string | null) => void;
  startDraft: (type: NodeType) => void;
  cancelDraft: () => void;
};

export const useGraphStore = create<State & Actions>((set) => ({
  workspaceId: null,
  nodes: [],
  edges: [],
  dbClusters: [],
  selectedNodeId: null,
  draftType: null,

  setInitial: ({ workspaceId, nodes, edges, dbClusters }) =>
    set({ workspaceId, nodes, edges, dbClusters: dbClusters ?? [] }),

  upsertNode: (n) =>
    set((s) => {
      const idx = s.nodes.findIndex((x) => x.id === n.id);
      if (idx === -1) return { nodes: [...s.nodes, n] };
      const next = s.nodes.slice();
      next[idx] = n;
      return { nodes: next };
    }),

  removeNode: (id) =>
    set((s) => ({
      nodes: s.nodes.filter((n) => n.id !== id),
      // also drop edges referencing this node (DB does this via cascade,
      // we mirror locally so UI updates without a refetch)
      edges: s.edges.filter(
        (e) => e.source_id !== id && e.target_id !== id,
      ),
      selectedNodeId: s.selectedNodeId === id ? null : s.selectedNodeId,
    })),

  upsertEdge: (e) =>
    set((s) => {
      const idx = s.edges.findIndex((x) => x.id === e.id);
      if (idx === -1) return { edges: [...s.edges, e] };
      const next = s.edges.slice();
      next[idx] = e;
      return { edges: next };
    }),

  removeEdge: (id) =>
    set((s) => ({ edges: s.edges.filter((e) => e.id !== id) })),

  setEdges: (edges) => set({ edges }),

  setDbClusters: (clusters) => set({ dbClusters: clusters }),

  applyClusters: (nodes, clusters) => set({ nodes, dbClusters: clusters }),

  // Selecting a node always clears any in-progress draft (mutually exclusive).
  selectNode: (id) => set({ selectedNodeId: id, draftType: null }),

  // Starting a draft clears any existing selection.
  startDraft: (type) => set({ draftType: type, selectedNodeId: null }),

  cancelDraft: () => set({ draftType: null }),
}));
