"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import ChatPanel from "@/components/ChatPanel";
import GraphCanvas from "@/components/GraphCanvas";
import Sidebar from "@/components/Sidebar";
import { EDGE_TIERS } from "@/lib/edgeTiers";
import { api } from "@/lib/api";
import * as db from "@/lib/db";
import type { DbEdge, DbNode, NodeType } from "@/lib/db";
import { supabase } from "@/lib/supabase";
import { useGraphStore } from "@/lib/store";

type RebuildEdgesResponse = {
  edges_created: number;
  threshold: number;
};

type AutoConnectStatus = "idle" | "running" | "done" | "failed";

type Props = {
  userEmail: string;
  workspaceId: string;
  workspaceName: string;
  initialNodes: DbNode[];
  initialEdges: DbEdge[];
};

const NODE_TYPES: NodeType[] = ["note", "doc", "url"];

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
}: Props) {
  const router = useRouter();
  const setInitial = useGraphStore((s) => s.setInitial);
  const upsertNode = useGraphStore((s) => s.upsertNode);
  const setEdges = useGraphStore((s) => s.setEdges);
  const selectNode = useGraphStore((s) => s.selectNode);
  const selectedNodeId = useGraphStore((s) => s.selectedNodeId);
  const nodeCount = useGraphStore((s) => s.nodes.length);

  const [showGrid, setShowGrid] = useState(false);
  const [fitTrigger, setFitTrigger] = useState(0);
  const [autoConnect, setAutoConnect] = useState<AutoConnectStatus>("idle");
  const [autoConnectMsg, setAutoConnectMsg] = useState<string>("");

  useEffect(() => {
    setInitial({
      workspaceId,
      nodes: initialNodes,
      edges: initialEdges,
    });
  }, [workspaceId, initialNodes, initialEdges, setInitial]);

  async function addNode(type: NodeType) {
    try {
      const node = await db.createNode({
        workspace_id: workspaceId,
        type,
        title:
          type === "note"
            ? "New thought"
            : type === "doc"
              ? "New doc"
              : "New URL",
        content: "",
        // Positions are ignored by the 3D canvas (force-directed). Any value is fine.
        x: 0,
        y: 0,
      });
      upsertNode(node);
      selectNode(node.id);
    } catch (e) {
      console.error("createNode failed", e);
    }
  }

  async function signOut() {
    await supabase().auth.signOut();
    router.push("/login");
    router.refresh();
  }

  async function autoConnectGraph() {
    if (autoConnect === "running") return;
    setAutoConnect("running");
    setAutoConnectMsg("");
    try {
      const res = await api<RebuildEdgesResponse>(
        `/workspaces/${workspaceId}/rebuild-edges`,
        { method: "POST" },
      );
      // Refresh edges from DB into the store — RLS handles isolation.
      const fresh = await db.listEdges(workspaceId);
      setEdges(fresh);
      setAutoConnect("done");
      setAutoConnectMsg(
        `${res.edges_created} semantic edge${res.edges_created === 1 ? "" : "s"} created`,
      );
      // Fade the chip after 4s
      setTimeout(() => setAutoConnect("idle"), 4000);
    } catch (e) {
      setAutoConnect("failed");
      setAutoConnectMsg(e instanceof Error ? e.message : String(e));
    }
  }

  const sidebarOpen = !!selectedNodeId;

  return (
    <div className="relative h-screen w-screen overflow-hidden bg-palace-bg">
      {/* Canvas — fills the entire viewport */}
      <div className="absolute inset-0">
        <GraphCanvas showGrid={showGrid} fitTrigger={fitTrigger} />
      </div>

      {/* Floating header with workspace + add-node + sign-out */}
      <header className="absolute left-0 right-0 top-0 z-20 flex items-center justify-between border-b border-palace-edge/60 bg-palace-bg/70 px-6 py-3 backdrop-blur-md">
        <div>
          <h1 className="text-base font-semibold">{workspaceName}</h1>
          <p className="text-xs text-neutral-500">
            {userEmail} · {nodeCount} node{nodeCount === 1 ? "" : "s"}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {NODE_TYPES.map((t) => (
            <button
              key={t}
              onClick={() => addNode(t)}
              className="rounded-lg bg-palace-accent/10 px-3 py-1 text-xs font-medium text-palace-accent ring-1 ring-palace-accent/40 hover:bg-palace-accent/20"
            >
              + {t}
            </button>
          ))}
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
