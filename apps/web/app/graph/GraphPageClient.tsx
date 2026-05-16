"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import AddNodeMenu from "@/components/AddNodeMenu";
import ChatPanel from "@/components/ChatPanel";
import GraphCanvas from "@/components/GraphCanvas";
import NodeSearch from "@/components/NodeSearch";
import Sidebar from "@/components/Sidebar";
import type { Cluster } from "@/lib/clusters";
import { EDGE_TIERS } from "@/lib/edgeTiers";
import { api } from "@/lib/api";
import * as db from "@/lib/db";
import type { DbCluster, DbEdge, DbNode, NodeType } from "@/lib/db";
import { supabase } from "@/lib/supabase";
import { useGraphStore } from "@/lib/store";

type RebuildEdgesResponse = {
  edges_created: number;
  threshold: number;
};

type AutoConnectStatus = "idle" | "running" | "done" | "failed";

type RecomputeClustersResponse = {
  clusters_created: number;
  k_chosen: number | null;
  silhouette: number | null;
  /** LLM naming calls actually issued. The rest were reused by members_hash. */
  naming_calls: number;
  naming_skipped: number;
  cost_usd: number;
};

type Props = {
  userEmail: string;
  workspaceId: string;
  workspaceName: string;
  initialNodes: DbNode[];
  initialEdges: DbEdge[];
  initialClusters: DbCluster[];
};


function LegendRow({
  color,
  label,
  range,
}: {
  color: string;
  label: string;
  range: string;
}) {
  return (
    <div className="flex items-center gap-2">
      <span
        className="inline-block h-[3px] w-7 rounded"
        style={{ background: color }}
      />
      <span className="flex-1">{label}</span>
      <span className="text-neutral-600">{range}</span>
    </div>
  );
}

export default function GraphPageClient({
  userEmail,
  workspaceId,
  workspaceName,
  initialNodes,
  initialEdges,
  initialClusters,
}: Props) {
  const router = useRouter();
  const setInitial = useGraphStore((s) => s.setInitial);
  const upsertNode = useGraphStore((s) => s.upsertNode);
  const setEdges = useGraphStore((s) => s.setEdges);
  const applyClusters = useGraphStore((s) => s.applyClusters);
  const selectNode = useGraphStore((s) => s.selectNode);
  const selectedNodeId = useGraphStore((s) => s.selectedNodeId);
  const nodeCount = useGraphStore((s) => s.nodes.length);

  const [showGrid, setShowGrid] = useState(false);
  const [fitTrigger, setFitTrigger] = useState(0);
  const [autoConnect, setAutoConnect] = useState<AutoConnectStatus>("idle");
  const [autoConnectMsg, setAutoConnectMsg] = useState<string>("");
  const [recompute, setRecompute] = useState<AutoConnectStatus>("idle");
  const [recomputeMsg, setRecomputeMsg] = useState<string>("");
  const startDraft = useGraphStore((s) => s.startDraft);
  const draftType = useGraphStore((s) => s.draftType);

  // Search → fly-to plumbing. Trigger increments per pick so the same
  // node can be re-flown to (e.g. user picks it, drifts the camera, then
  // re-clicks the same search match).
  const [flyToNodeId, setFlyToNodeId] = useState<string | null>(null);
  const [flyToTrigger, setFlyToTrigger] = useState(0);

  // Connected-components fallback clusters — bubbled up from GraphCanvas
  // when the workspace has no DB-persisted clusters yet. Once the user
  // clicks "Recompute topics", DB clusters take over and this stays unused.
  const [clusters, setClusters] = useState<Cluster[]>([]);

  // Focused-cluster filter. When set, the canvas dims all non-cluster nodes
  // and edges so the user can see one topic in isolation. Click again on
  // the same legend row (or background) to clear.
  const [focusedClusterId, setFocusedClusterId] = useState<string | null>(null);

  useEffect(() => {
    setInitial({
      workspaceId,
      nodes: initialNodes,
      edges: initialEdges,
      dbClusters: initialClusters,
    });
  }, [workspaceId, initialNodes, initialEdges, initialClusters, setInitial]);

  /** Auto-connect handler usable from anywhere — buttons, post-save chains. */
  async function runAutoConnect() {
    setAutoConnect("running");
    setAutoConnectMsg("");
    try {
      const res = await api<RebuildEdgesResponse>(
        `/workspaces/${workspaceId}/rebuild-edges`,
        { method: "POST" },
      );
      const fresh = await db.listEdges(workspaceId);
      setEdges(fresh);
      setAutoConnect("done");
      setAutoConnectMsg(
        `${res.edges_created} semantic edge${res.edges_created === 1 ? "" : "s"} created`,
      );
      setTimeout(() => setAutoConnect("idle"), 4000);
    } catch (e) {
      setAutoConnect("failed");
      setAutoConnectMsg(e instanceof Error ? e.message : String(e));
    }
  }

  async function signOut() {
    await supabase().auth.signOut();
    router.push("/login");
    router.refresh();
  }

  async function autoConnectGraph() {
    if (autoConnect === "running") return;
    await runAutoConnect();
  }

  /** "🧠 Curate memory" — P3.4 memory agent. Fires a curation prompt at
   *  `/agent` via ChatPanel's mempalace:ask event hook. The agent uses
   *  the existing read tools to explore + the create_note write tool to
   *  propose summaries for under-curated clusters. Every proposal goes
   *  through the same approval card the user already knows.
   *
   *  No new endpoint, no new agent loop variant — the "memory agent" is
   *  just the regular agent with a different opening question. The
   *  substrate built in P3.1/P3.2/P3.3 (loop + reflection + propose-then-
   *  approve) carries it all. */
  function curateMemory() {
    const prompt = [
      "Review my memory palace and propose summary notes for clusters",
      "that would genuinely benefit from one. Be SELECTIVE — quality over",
      "quantity. Each proposal needs my approval before anything is created.",
      "",
      "Process:",
      "1. Call list_clusters() to see what topics exist.",
      "2. For each cluster with 3 or more members, call",
      "   read_cluster_members(cluster_id) to inspect its contents.",
      "3. SKIP a cluster if ANY of these are true:",
      "   - It already contains a member whose title starts with 'Summary'",
      "     or contains the word 'summary' (don't double-summarize).",
      "   - It has fewer than 3 members.",
      "   - Its members are short single-sentence notes that already say",
      "     what they need to say (a summary would add nothing).",
      "4. For up to 3 REMAINING clusters worth summarizing, read the most",
      "   relevant members with read_node and propose ONE create_note per",
      "   cluster. NEVER propose two notes for the same cluster — one",
      "   proposal per cluster, period.",
      "5. End with a short message naming which proposals you made (or",
      "   say plainly that nothing needs summarizing).",
      "",
      "If you find yourself wanting to propose a 4th summary, prefer to",
      "stop instead — the user can run Curate again later. If you find",
      "yourself proposing duplicates, you've made a mistake — drop the",
      "duplicate before responding.",
    ].join("\n");

    window.dispatchEvent(
      new CustomEvent("mempalace:ask", {
        detail: { question: prompt, agent: true },
      }),
    );
  }

  /** "🏷 Recompute topics" — k-means + LLM-named clusters via the API. */
  async function runRecomputeClusters() {
    setRecompute("running");
    setRecomputeMsg("");
    try {
      const res = await api<RecomputeClustersResponse>(
        `/workspaces/${workspaceId}/recompute-clusters`,
        { method: "POST" },
      );
      // Endpoint mutated nodes.cluster_id and replaced clusters table; refetch
      // both so the canvas re-renders with the fresh ids/labels.
      const [freshNodes, freshClusters] = await Promise.all([
        db.listNodes(workspaceId),
        db.listClusters(workspaceId),
      ]);
      applyClusters(freshNodes, freshClusters);
      setRecompute("done");
      const reuseFrag =
        res.naming_skipped > 0
          ? ` · ${res.naming_calls} named, ${res.naming_skipped} reused`
          : "";
      setRecomputeMsg(
        `${res.clusters_created} topic${res.clusters_created === 1 ? "" : "s"}` +
          (res.silhouette != null ? ` · silhouette ${res.silhouette.toFixed(2)}` : "") +
          reuseFrag +
          ` · $${res.cost_usd.toFixed(4)}`,
      );
      setTimeout(() => setRecompute("idle"), 5000);
    } catch (e) {
      setRecompute("failed");
      setRecomputeMsg(e instanceof Error ? e.message : String(e));
    }
  }

  const sidebarOpen = !!selectedNodeId || !!draftType;

  return (
    <div className="relative h-screen w-screen overflow-hidden bg-palace-bg">
      {/* Canvas — fills the entire viewport */}
      <div className="absolute inset-0">
        <GraphCanvas
          showGrid={showGrid}
          fitTrigger={fitTrigger}
          flyToNodeId={flyToNodeId}
          flyToTrigger={flyToTrigger}
          onClustersChange={setClusters}
          focusedClusterId={focusedClusterId}
        />
      </div>

      {/* Floating search — top-left under the header */}
      <NodeSearch
        onPick={(id) => {
          setFlyToNodeId(id);
          setFlyToTrigger((t) => t + 1);
        }}
      />

      {/* Floating header with workspace + add-node + sign-out */}
      <header className="absolute left-0 right-0 top-0 z-20 flex items-center justify-between border-b border-palace-edge/60 bg-palace-bg/70 px-6 py-3 backdrop-blur-md">
        <div>
          <h1 className="text-base font-semibold">{workspaceName}</h1>
          <p className="text-xs text-neutral-500">
            {userEmail} · {nodeCount} node{nodeCount === 1 ? "" : "s"}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <AddNodeMenu onPick={(t) => startDraft(t)} />
          <Link
            href="/insights"
            className="ml-2 rounded-lg px-3 py-1 text-xs text-neutral-400 ring-1 ring-palace-edge hover:bg-palace-panel hover:text-neutral-100"
            title="LLM observability — costs, latency, prompts"
          >
            Insights
          </Link>
          <button
            onClick={signOut}
            className="rounded-lg px-3 py-1 text-xs text-neutral-400 ring-1 ring-palace-edge hover:bg-palace-panel hover:text-neutral-100"
          >
            Sign out
          </button>
        </div>
      </header>

      {/* Canvas controls — top-right under the header */}
      <div className="absolute right-6 top-20 z-10 flex flex-col items-end gap-2">
        <label className="flex cursor-pointer items-center gap-2 rounded-lg bg-palace-panel/80 px-3 py-1.5 text-xs text-neutral-300 ring-1 ring-palace-edge backdrop-blur hover:bg-palace-panel">
          <input
            type="checkbox"
            checked={showGrid}
            onChange={(e) => setShowGrid(e.target.checked)}
            className="accent-palace-accent"
          />
          Floor grid
        </label>
        <button
          onClick={() => setFitTrigger((c) => c + 1)}
          className="rounded-lg bg-palace-panel/80 px-3 py-1.5 text-xs text-neutral-300 ring-1 ring-palace-edge backdrop-blur hover:bg-palace-panel"
          title="Recenter and zoom to fit all nodes"
        >
          Fit view
        </button>
        <button
          onClick={autoConnectGraph}
          disabled={autoConnect === "running"}
          className="rounded-lg bg-palace-accent/15 px-3 py-1.5 text-xs font-medium text-palace-accent ring-1 ring-palace-accent/40 backdrop-blur hover:bg-palace-accent/25 disabled:opacity-60"
          title="Find semantically similar nodes and connect them with semantic edges"
        >
          {autoConnect === "running" ? "Connecting…" : "✨ Auto-connect"}
        </button>
        {autoConnect === "done" && autoConnectMsg && (
          <span className="rounded-md bg-emerald-950/40 px-2 py-1 text-[11px] text-emerald-300 ring-1 ring-emerald-900/60">
            ✓ {autoConnectMsg}
          </span>
        )}
        {autoConnect === "failed" && autoConnectMsg && (
          <span className="max-w-[260px] truncate rounded-md bg-red-950/40 px-2 py-1 text-[11px] text-red-300 ring-1 ring-red-900/60">
            {autoConnectMsg}
          </span>
        )}

        {/* Topic clustering — k-means on node embeddings + LLM-named labels */}
        <button
          onClick={runRecomputeClusters}
          disabled={recompute === "running"}
          className="rounded-lg bg-violet-500/15 px-3 py-1.5 text-xs font-medium text-violet-300 ring-1 ring-violet-500/40 backdrop-blur hover:bg-violet-500/25 disabled:opacity-60"
          title="Group nodes into topics by content similarity, then ask gpt-4o-mini to name each group"
        >
          {recompute === "running" ? "Clustering…" : "🏷 Recompute topics"}
        </button>
        {recompute === "done" && recomputeMsg && (
          <span className="rounded-md bg-emerald-950/40 px-2 py-1 text-[11px] text-emerald-300 ring-1 ring-emerald-900/60">
            ✓ {recomputeMsg}
          </span>
        )}
        {recompute === "failed" && recomputeMsg && (
          <span className="max-w-[260px] truncate rounded-md bg-red-950/40 px-2 py-1 text-[11px] text-red-300 ring-1 ring-red-900/60">
            {recomputeMsg}
          </span>
        )}

        {/* P3.4 memory agent — fires a curation prompt at /agent through
            ChatPanel via the global custom-event hook. Opens the chat
            panel + runs the agent + surfaces any create_note proposals
            in the existing approval card. */}
        <button
          onClick={curateMemory}
          className="rounded-lg bg-violet-500/15 px-3 py-1.5 text-xs font-medium text-violet-300 ring-1 ring-violet-500/40 backdrop-blur hover:bg-violet-500/25"
          title="Ask the agent to review your memory and propose summary notes for under-curated clusters. Each proposal needs your approval before anything is created."
        >
          🧠 Curate memory
        </button>

        {/* Edge-strength legend */}
        <div className="mt-1 space-y-1 rounded-lg bg-palace-panel/80 px-3 py-2 text-[10px] text-neutral-300 ring-1 ring-palace-edge backdrop-blur">
          <div className="mb-1 text-[9px] font-semibold uppercase tracking-wider text-neutral-500">
            Edge strength
          </div>
          <LegendRow
            color={EDGE_TIERS.strong.color}
            label={EDGE_TIERS.strong.label}
            range={`≥ ${EDGE_TIERS.strong.min.toFixed(2)}`}
          />
          <LegendRow
            color={EDGE_TIERS.medium.color}
            label={EDGE_TIERS.medium.label}
            range={`${EDGE_TIERS.medium.min.toFixed(2)}–${EDGE_TIERS.strong.min.toFixed(2)}`}
          />
          <LegendRow
            color={EDGE_TIERS.weak.color}
            label={EDGE_TIERS.weak.label}
            range={`${EDGE_TIERS.weak.min.toFixed(2)}–${EDGE_TIERS.medium.min.toFixed(2)}`}
          />
        </div>

        {/* Cluster legend — clickable. Each row toggles "focus this cluster":
            the canvas dims all non-member nodes and edges so the topic stands
            out. Re-clicking the active row (or any row) clears the focus. */}
        {clusters.length > 0 && (
          <div className="space-y-1 rounded-lg bg-palace-panel/80 px-3 py-2 text-[10px] text-neutral-300 ring-1 ring-palace-edge backdrop-blur">
            <div className="mb-1 flex items-center justify-between">
              <span className="text-[9px] font-semibold uppercase tracking-wider text-neutral-500">
                Clusters ({clusters.length})
              </span>
              {focusedClusterId && (
                <button
                  onClick={() => setFocusedClusterId(null)}
                  className="text-[9px] uppercase tracking-wider text-neutral-500 hover:text-neutral-200"
                  title="Clear cluster focus"
                >
                  clear
                </button>
              )}
            </div>
            {clusters.map((c) => {
              const focused = c.id === focusedClusterId;
              const dimmed = focusedClusterId != null && !focused;
              return (
                <button
                  key={c.id}
                  type="button"
                  onClick={() =>
                    setFocusedClusterId(focused ? null : c.id)
                  }
                  className={`flex w-full items-center gap-2 rounded px-1 py-0.5 text-left transition ${
                    focused
                      ? "bg-palace-accent/15 ring-1 ring-palace-accent/50"
                      : dimmed
                        ? "opacity-40 hover:opacity-100"
                        : "hover:bg-palace-bg/60"
                  }`}
                  title={
                    focused
                      ? "Focused — click to clear"
                      : `Focus on ${c.label}`
                  }
                >
                  <span
                    className="inline-block h-2 w-2 rounded-full"
                    style={{ background: c.color }}
                  />
                  <span className="flex-1 truncate">{c.label}</span>
                  <span className="text-neutral-600">{c.members.length}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Sidebar — slides in from the right when a node is selected */}
      <div
        className={`absolute right-0 top-0 z-30 h-screen w-[380px] transform transition-transform duration-300 ease-out ${
          sidebarOpen ? "translate-x-0" : "translate-x-full"
        }`}
        aria-hidden={!sidebarOpen}
      >
        <Sidebar />
      </div>

      {/* Chat — bottom-left fixed */}
      <ChatPanel />
    </div>
  );
}
