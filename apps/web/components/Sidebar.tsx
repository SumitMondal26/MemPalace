"use client";

import { useEffect, useState } from "react";

import { api } from "@/lib/api";
import * as db from "@/lib/db";
import type { DbUpload } from "@/lib/db";
import { useGraphStore } from "@/lib/store";
import UploadDropzone from "./UploadDropzone";

type IndexStatus = "idle" | "indexing" | "indexed" | "failed";

export default function Sidebar() {
  const selectedId = useGraphStore((s) => s.selectedNodeId);
  const node = useGraphStore((s) =>
    selectedId ? s.nodes.find((n) => n.id === selectedId) : undefined,
  );
  const upsertNode = useGraphStore((s) => s.upsertNode);
  const removeNode = useGraphStore((s) => s.removeNode);
  const selectNode = useGraphStore((s) => s.selectNode);

  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [indexStatus, setIndexStatus] = useState<IndexStatus>("idle");

  // Persisted-state view of this node: what's already on the server?
  const [chunkCount, setChunkCount] = useState<number | null>(null);
  const [upload, setUpload] = useState<DbUpload | null>(null);

  // When selected node changes, sync form + fetch existing chunk/upload state.
  useEffect(() => {
    setTitle(node?.title ?? "");
    setContent(node?.content ?? "");
    setError(null);
    setIndexStatus("idle");
    setChunkCount(null);
    setUpload(null);

    if (!node) return;
    let cancelled = false;
    (async () => {
      try {
        const [cnt, up] = await Promise.all([
          db.getNodeChunkCount(node.id),
          node.type === "doc" ? db.getLatestUpload(node.id) : Promise.resolve(null),
        ]);
        if (cancelled) return;
        setChunkCount(cnt);
        setUpload(up);
      } catch (e) {
        if (cancelled) return;
        console.warn("failed to load node state", e);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [node?.id, node?.title, node?.content, node?.type]);

  async function refreshState() {
    if (!node) return;
    try {
      const [cnt, up] = await Promise.all([
        db.getNodeChunkCount(node.id),
        node.type === "doc" ? db.getLatestUpload(node.id) : Promise.resolve(null),
      ]);
      setChunkCount(cnt);
      setUpload(up);
    } catch (e) {
      console.warn("refresh failed", e);
    }
  }

  function indexNode(nodeId: string) {
    setIndexStatus("indexing");
    api<{ chunks_created: number }>(`/nodes/${nodeId}/embed`, {
      method: "POST",
    })
      .then((res) => {
        setIndexStatus("indexed");
        setChunkCount(res.chunks_created);
        // chip auto-fades to idle after 4s
        setTimeout(() => setIndexStatus("idle"), 4000);
      })
      .catch((e) => {
        setIndexStatus("failed");
        console.warn("embed failed", e);
      });
  }

  async function save() {
    if (!node) return;
    setSaving(true);
    setError(null);
    try {
      const updated = await db.updateNode(node.id, { title, content });
      upsertNode(updated);
      if (node.type === "note" || node.type === "url") {
        indexNode(node.id);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  function reindex() {
    if (!node) return;
    indexNode(node.id);
  }

  async function destroy() {
    if (!node) return;
    if (
      !confirm(
        `Delete "${node.title ?? "Untitled"}"? This also removes its edges and chunks.`,
      )
    ) {
      return;
    }
    try {
      await db.deleteNode(node.id);
      removeNode(node.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  if (!node) {
    return (
      <aside className="flex h-full flex-col border-l border-palace-edge bg-palace-panel/50 p-6 text-sm text-neutral-500">
        <p className="font-medium text-neutral-400">No node selected</p>
        <p className="mt-2">
          Click a node to edit it. Drag from a node&rsquo;s right handle to
          another node&rsquo;s left handle to create a manual edge.
        </p>
        <p className="mt-2 text-xs">
          Saving a note also embeds it for search — ask anything in the chat
          panel and it&rsquo;ll find your own thoughts alongside any uploaded
          docs.
        </p>
        <p className="mt-2 text-xs">
          Select an edge and press{" "}
          <kbd className="rounded bg-palace-bg px-1.5 py-0.5">Backspace</kbd>{" "}
          to delete it.
        </p>
      </aside>
    );
  }

  const isIndexable = node.type === "note" || node.type === "url";
  const hasContent = content.trim().length > 0;

  return (
    <aside className="flex h-full flex-col border-l border-palace-edge bg-palace-panel/50">
      <header className="border-b border-palace-edge p-4">
        <div className="flex items-center justify-between">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-neutral-500">
            {node.type}
          </div>
          {chunkCount != null && chunkCount > 0 && (
            <span className="rounded-full bg-emerald-950/40 px-2 py-0.5 text-[10px] font-medium text-emerald-300 ring-1 ring-emerald-900/60">
              ✓ {chunkCount} chunk{chunkCount === 1 ? "" : "s"} indexed
            </span>
          )}
        </div>
        <div className="mt-1 text-xs text-neutral-600">
          updated {new Date(node.updated_at).toLocaleString()}
        </div>
      </header>

      <div className="flex-1 space-y-3 overflow-auto p-4">
        <label className="block text-xs font-medium text-neutral-400">
          Title
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Untitled"
            className="mt-1 w-full rounded-lg bg-palace-bg px-3 py-2 text-sm text-neutral-100 outline-none ring-1 ring-palace-edge focus:ring-palace-accent"
          />
        </label>

        <label className="block text-xs font-medium text-neutral-400">
          Content
          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            rows={10}
            placeholder="Your thoughts, links, snippets..."
            className="mt-1 w-full resize-none rounded-lg bg-palace-bg px-3 py-2 text-sm text-neutral-100 outline-none ring-1 ring-palace-edge focus:ring-palace-accent"
          />
        </label>

        {error && (
          <p className="rounded-md bg-red-950/40 px-3 py-2 text-xs text-red-300">
            {error}
          </p>
        )}

        {isIndexable && (
          <div className="flex items-center justify-between text-xs">
            <div>
              {indexStatus === "indexing" && (
                <span className="text-neutral-400">indexing for search…</span>
              )}
              {indexStatus === "indexed" && (
                <span className="text-emerald-400">
                  ✓ just indexed
                  {chunkCount != null && (
                    <span className="ml-1 text-neutral-500">
                      ({chunkCount} chunk{chunkCount === 1 ? "" : "s"})
                    </span>
                  )}
                </span>
              )}
              {indexStatus === "failed" && (
                <span className="text-red-400">indexing failed</span>
              )}
              {indexStatus === "idle" &&
                (chunkCount == null ? (
                  <span className="text-neutral-600">loading…</span>
                ) : chunkCount > 0 ? (
                  <span className="text-emerald-500/80">
                    Indexed for search ({chunkCount} chunk
                    {chunkCount === 1 ? "" : "s"})
                  </span>
                ) : hasContent ? (
                  <span className="text-amber-400">
                    Not indexed yet — Save or Reindex
                  </span>
                ) : (
                  <span className="text-neutral-600">
                    Empty — nothing to index
                  </span>
                ))}
            </div>
            <button
              onClick={reindex}
              disabled={indexStatus === "indexing"}
              className="rounded px-2 py-0.5 text-[11px] text-neutral-500 hover:bg-palace-bg hover:text-neutral-200 disabled:opacity-50"
              title="Re-embed this node's content into chunks"
            >
              Reindex
            </button>
          </div>
        )}

        {node.type === "doc" && (
          <div className="space-y-2 pt-2">
            <h3 className="text-xs font-medium text-neutral-400">Source file</h3>
            <UploadDropzone
              nodeId={node.id}
              existing={upload}
              existingChunkCount={chunkCount ?? 0}
              onProcessed={() => {
                // Refresh both upload row + chunk count after a successful ingest.
                refreshState();
              }}
            />
          </div>
        )}
      </div>

      <footer className="flex items-center justify-between gap-2 border-t border-palace-edge p-4">
        <button
          onClick={destroy}
          className="rounded-lg px-3 py-1.5 text-xs text-red-300 ring-1 ring-red-900/60 hover:bg-red-950/30"
        >
          Delete
        </button>
        <div className="flex gap-2">
          <button
            onClick={() => selectNode(null)}
            className="rounded-lg px-3 py-1.5 text-xs text-neutral-400 ring-1 ring-palace-edge hover:bg-palace-bg"
          >
            Close
          </button>
          <button
            onClick={save}
            disabled={saving}
            className="rounded-lg bg-palace-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-palace-accent/90 disabled:opacity-50"
          >
            {saving ? "..." : "Save"}
          </button>
        </div>
      </footer>
    </aside>
  );
}
