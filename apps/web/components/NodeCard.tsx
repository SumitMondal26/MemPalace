"use client";

import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";

export type CardNodeData = {
  title: string | null;
  type: string;
  content: string | null;
};

export type CardNode = Node<CardNodeData, "card">;

const TYPE_BADGE: Record<string, string> = {
  note: "text-sky-400",
  doc: "text-amber-400",
  image: "text-emerald-400",
  url: "text-pink-400",
  cluster: "text-purple-400",
};

export default function NodeCard({ data, selected }: NodeProps<CardNode>) {
  return (
    <div
      className={[
        "min-w-[140px] max-w-[220px] rounded-xl border bg-palace-panel px-3 py-2 text-sm shadow-lg transition",
        selected
          ? "border-palace-accent ring-2 ring-palace-accent/40"
          : "border-palace-edge hover:border-neutral-500",
      ].join(" ")}
    >
      <Handle
        type="target"
        position={Position.Left}
        className="!h-2 !w-2 !border-0 !bg-palace-accent"
      />
      <div
        className={`text-[10px] font-semibold uppercase tracking-wider ${
          TYPE_BADGE[data.type] ?? "text-neutral-500"
        }`}
      >
        {data.type}
      </div>
      <div className="mt-0.5 truncate font-medium text-neutral-100">
        {data.title || "Untitled"}
      </div>
      {data.content && (
        <div
          className="mt-1 overflow-hidden text-xs leading-snug text-neutral-400"
          style={{
            display: "-webkit-box",
            WebkitLineClamp: 2,
            WebkitBoxOrient: "vertical",
          }}
        >
          {data.content}
        </div>
      )}
      <Handle
        type="source"
        position={Position.Right}
        className="!h-2 !w-2 !border-0 !bg-palace-accent"
      />
    </div>
  );
}
