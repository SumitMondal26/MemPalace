"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { useGraphStore } from "@/lib/store";

/**
 * Node search — floating input top-left of the canvas.
 *
 * Behavior:
 *  - Live filter on title substring as you type.
 *  - Up to 8 matches surfaced as a dropdown.
 *  - Pick a match (click or Enter on the highlighted row) → selects the node
 *    in the store (which opens the sidebar). The parent registers a callback
 *    via `onPick` so the camera can fly to it.
 *  - Keyboard: ↑/↓ navigate, Enter pick, Esc clear+blur, "/" anywhere on the
 *    page focuses the input (skipped when already typing in another input).
 *
 * Why this UI shape:
 *  - At 14+ nodes, click-to-find scales linearly; substring search collapses
 *    that to keystrokes-to-find. Same fix as a file picker in any editor.
 *  - Top-left places it opposite the canvas controls (top-right) and above
 *    the chat panel — visually balanced, no overlap with the sidebar.
 */
export default function NodeSearch({
  onPick,
}: {
  /** Called after a match is picked, with the node's id. The canvas wires
   *  this to `cameraPosition` to fly the camera. */
  onPick: (nodeId: string) => void;
}) {
  const nodes = useGraphStore((s) => s.nodes);
  const selectNode = useGraphStore((s) => s.selectNode);

  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Page-wide "/" shortcut to focus the search.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/") return;
      const tag = (e.target as HTMLElement | null)?.tagName?.toLowerCase();
      // Don't hijack while user is typing in another input/textarea.
      if (tag === "input" || tag === "textarea" || (e.target as HTMLElement)?.isContentEditable) return;
      e.preventDefault();
      inputRef.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return nodes
      .filter((n) => (n.title ?? "").toLowerCase().includes(q))
      .slice(0, 8);
  }, [query, nodes]);

  // Keep activeIdx in range as matches shift under it.
  useEffect(() => {
    if (activeIdx >= matches.length) setActiveIdx(0);
  }, [matches.length, activeIdx]);

  function pick(nodeId: string) {
    selectNode(nodeId);
    onPick(nodeId);
    setQuery("");
    setOpen(false);
    inputRef.current?.blur();
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Escape") {
      setQuery("");
      setOpen(false);
      inputRef.current?.blur();
      return;
    }
    if (matches.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIdx((i) => (i + 1) % matches.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIdx((i) => (i - 1 + matches.length) % matches.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const m = matches[activeIdx];
      if (m) pick(m.id);
    }
  }

  return (
    <div className="absolute left-6 top-20 z-10 w-72">
      <div className="rounded-lg bg-palace-panel/80 ring-1 ring-palace-edge backdrop-blur">
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          placeholder="Search nodes…  (press / )"
          className="w-full bg-transparent px-3 py-2 text-xs text-neutral-200 placeholder:text-neutral-500 focus:outline-none"
        />
      </div>

      {open && query.trim() && matches.length > 0 && (
        <ul className="mt-1 max-h-72 overflow-y-auto rounded-lg bg-palace-panel/95 py-1 text-xs ring-1 ring-palace-edge backdrop-blur">
          {matches.map((m, i) => (
            <li
              key={m.id}
              onMouseDown={(e) => {
                // mousedown beats blur → click handler still runs
                e.preventDefault();
                pick(m.id);
              }}
              onMouseEnter={() => setActiveIdx(i)}
              className={`flex cursor-pointer items-center justify-between px-3 py-1.5 ${
                i === activeIdx
                  ? "bg-palace-accent/20 text-white"
                  : "text-neutral-300 hover:bg-palace-bg/60"
              }`}
            >
              <span className="truncate">{m.title || "(untitled)"}</span>
              <span className="ml-2 shrink-0 text-[9px] uppercase tracking-wider text-neutral-500">
                {m.type}
              </span>
            </li>
          ))}
        </ul>
      )}
      {open && query.trim() && matches.length === 0 && (
        <div className="mt-1 rounded-lg bg-palace-panel/95 px-3 py-2 text-xs text-neutral-500 ring-1 ring-palace-edge backdrop-blur">
          No matches.
        </div>
      )}
    </div>
  );
}
