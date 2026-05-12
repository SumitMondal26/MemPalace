"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import ChatPanel from "@/components/ChatPanel";
import GraphCanvas from "@/components/GraphCanvas";
import Sidebar from "@/components/Sidebar";
import * as db from "@/lib/db";
import type { DbEdge, DbNode, NodeType } from "@/lib/db";
import { supabase } from "@/lib/supabase";
import { useGraphStore } from "@/lib/store";

type Props = {
  userEmail: string;
  workspaceId: string;
  workspaceName: string;
  initialNodes: DbNode[];
  initialEdges: DbEdge[];
};

const NODE_TYPES: NodeType[] = ["note", "doc", "url"];

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
  const selectNode = useGraphStore((s) => s.selectNode);
  const selectedNodeId = useGraphStore((s) => s.selectedNodeId);
  const nodeCount = useGraphStore((s) => s.nodes.length);

  const [showGrid, setShowGrid] = useState(false);
  const [fitTrigger, setFitTrigger] = useState(0);

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
          <button
            onClick={signOut}
            className="ml-2 rounded-lg px-3 py-1 text-xs text-neutral-400 ring-1 ring-palace-edge hover:bg-palace-panel hover:text-neutral-100"
          >
            Sign out
          </button>
        </div>
      </header>

      {/* Canvas controls — top-right under the header */}
      <div className="absolute right-6 top-20 z-10 flex flex-col gap-2">
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
