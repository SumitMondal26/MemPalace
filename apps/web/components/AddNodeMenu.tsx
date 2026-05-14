"use client";

import { useEffect, useRef, useState } from "react";

import type { NodeType } from "@/lib/db";

type Option = {
  type: NodeType;
  label: string;
  hint: string;
  hue: string;
};

const OPTIONS: Option[] = [
  {
    type: "note",
    label: "Note",
    hint: "A thought, fact, or snippet you type yourself.",
    hue: "text-cyan-400",
  },
  {
    type: "doc",
    label: "Document",
    hint: "Upload a PDF or text file. Chunked + embedded for RAG.",
    hue: "text-amber-400",
  },
  {
    type: "url",
    label: "URL",
    hint: "A link with optional notes. (P2: auto-fetch + summarize.)",
    hue: "text-pink-400",
  },
];

export default function AddNodeMenu({
  onPick,
}: {
  onPick: (type: NodeType) => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  // Click outside to close.
  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    }
    function onEsc(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onEsc);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onEsc);
    };
  }, [open]);

  return (
    <div ref={wrapRef} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="rounded-lg bg-palace-accent/15 px-3 py-1 text-xs font-medium text-palace-accent ring-1 ring-palace-accent/40 hover:bg-palace-accent/25"
      >
        + Add memory {open ? "▾" : "▸"}
      </button>
      {open && (
        <div className="absolute right-0 top-full z-30 mt-1 w-72 overflow-hidden rounded-lg bg-palace-panel/95 ring-1 ring-palace-edge shadow-2xl backdrop-blur">
          {OPTIONS.map((opt) => (
            <button
              key={opt.type}
              onClick={() => {
                setOpen(false);
                onPick(opt.type);
              }}
              className="block w-full border-b border-palace-edge/60 px-3 py-2 text-left last:border-b-0 hover:bg-palace-bg"
            >
              <div className={`text-sm font-medium ${opt.hue}`}>{opt.label}</div>
              <div className="mt-0.5 text-[11px] text-neutral-500">{opt.hint}</div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
