"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

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
  const nodeCount = useGraphStore((s) => s.nodes.length);

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
        title: type === "note" ? "New thought" : type === "doc" ? "New doc" : "New URL",
        content: "",
        // scatter new nodes so they don't all stack
        x: 80 + Math.random() * 360,
        y: 80 + Math.random() * 260,
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

  return (
    <div className="grid h-screen grid-cols-[1fr_340px] grid-rows-[auto_1fr]">
      <header className="col-span-2 flex items-center justify-between border-b border-palace-edge bg-palace-bg/80 px-6 py-3 backdrop-blur">
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

      <main className="relative">
        <GraphCanvas />
      </main>

      <Sidebar />
      <ChatPanel />
    </div>
  );
}
