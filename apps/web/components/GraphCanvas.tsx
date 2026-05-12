"use client";

import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  useEdgesState,
  useNodesState,
  type Connection,
  type Edge as RFEdge,
  type Node as RFNode,
  type NodeTypes,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import { useCallback, useEffect } from "react";

import * as db from "@/lib/db";
import { useGraphStore } from "@/lib/store";
import NodeCard, { type CardNode } from "./NodeCard";

const nodeTypes: NodeTypes = { card: NodeCard };

function toRFNode(n: db.DbNode): RFNode {
  return {
    id: n.id,
    type: "card",
    position: { x: n.x, y: n.y },
    data: { title: n.title, type: n.type, content: n.content },
  } as CardNode;
}

function toRFEdge(e: db.DbEdge): RFEdge {
  return {
    id: e.id,
    source: e.source_id,
    target: e.target_id,
    animated: e.kind === "semantic",
    style: e.kind === "semantic" ? { stroke: "#7c5cff" } : undefined,
  };
}

export default function GraphCanvas() {
  const workspaceId = useGraphStore((s) => s.workspaceId);
  const dbNodes = useGraphStore((s) => s.nodes);
  const dbEdges = useGraphStore((s) => s.edges);
  const selectedNodeId = useGraphStore((s) => s.selectedNodeId);
  const upsertNode = useGraphStore((s) => s.upsertNode);
  const upsertEdge = useGraphStore((s) => s.upsertEdge);
  const removeEdge = useGraphStore((s) => s.removeEdge);
  const selectNode = useGraphStore((s) => s.selectNode);

  // React Flow's local node/edge state. Resync whenever the store changes.
  // This split lets RF own smooth drag updates while DB stays the truth.
  const [rfNodes, setRfNodes, onNodesChange] = useNodesState<RFNode>([]);
  const [rfEdges, setRfEdges, onEdgesChange] = useEdgesState<RFEdge>([]);

  useEffect(() => {
    setRfNodes(
      dbNodes.map((n) => ({
        ...toRFNode(n),
        selected: n.id === selectedNodeId,
      })),
    );
  }, [dbNodes, selectedNodeId, setRfNodes]);

  useEffect(() => {
    setRfEdges(dbEdges.map(toRFEdge));
  }, [dbEdges, setRfEdges]);

  const onNodeDragStop = useCallback(
    async (_: unknown, node: RFNode) => {
      try {
        const updated = await db.updateNode(node.id, {
          x: node.position.x,
          y: node.position.y,
        });
        upsertNode(updated);
      } catch (e) {
        console.error("persist position failed", e);
      }
    },
    [upsertNode],
  );

  const onConnect = useCallback(
    async (conn: Connection) => {
      if (!workspaceId || !conn.source || !conn.target) return;
      if (conn.source === conn.target) return; // no self-loops in P1
      try {
        const edge = await db.createEdge({
          workspace_id: workspaceId,
          source_id: conn.source,
          target_id: conn.target,
        });
        upsertEdge(edge);
      } catch (e) {
        console.error("createEdge failed", e);
      }
    },
    [workspaceId, upsertEdge],
  );

  const onEdgesDelete = useCallback(
    async (edges: RFEdge[]) => {
      await Promise.all(
        edges.map(async (e) => {
          try {
            await db.deleteEdge(e.id);
            removeEdge(e.id);
          } catch (err) {
            console.error("deleteEdge failed", err);
          }
        }),
      );
    },
    [removeEdge],
  );

  const onNodeClick = useCallback(
    (_: unknown, node: RFNode) => selectNode(node.id),
    [selectNode],
  );

  const onPaneClick = useCallback(() => selectNode(null), [selectNode]);

  return (
    <ReactFlow
      nodes={rfNodes}
      edges={rfEdges}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      onNodeDragStop={onNodeDragStop}
      onConnect={onConnect}
      onEdgesDelete={onEdgesDelete}
      onNodeClick={onNodeClick}
      onPaneClick={onPaneClick}
      nodeTypes={nodeTypes}
      colorMode="dark"
      fitView
      proOptions={{ hideAttribution: true }}
    >
      <Background gap={24} size={1} color="#1f2030" />
      <Controls position="bottom-right" />
      <MiniMap
        pannable
        zoomable
        className="!bg-palace-panel"
        nodeColor={(n) => (n.selected ? "#7c5cff" : "#3b3d52")}
        maskColor="rgba(10, 10, 15, 0.7)"
      />
    </ReactFlow>
  );
}
