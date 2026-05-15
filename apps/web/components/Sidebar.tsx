"use client";

import { useEffect, useRef, useState } from "react";

import { api } from "@/lib/api";
import * as db from "@/lib/db";
import type { DbUpload, NodeType } from "@/lib/db";
import { useGraphStore } from "@/lib/store";
import MediaPreview from "./MediaPreview";
import UploadDropzone from "./UploadDropzone";

type IndexStatus = "idle" | "indexing" | "indexed" | "failed";

const DRAFT_COPY: Record<
  NodeType,
  { heading: string; sub: string; cta: string }
> = {
  note: {
    heading: "New note",
    sub: "A thought, fact, or snippet. Embedded immediately on save.",
    cta: "Create note",
  },
  doc: {
    heading: "New document",
    sub: "Pick a title now. Upload the file once the node is created.",
    cta: "Create document",
  },
  url: {
    heading: "New URL",
    sub: "Save a link with optional notes. (Auto-fetch + summarize is P2.)",
    cta: "Save URL",
  },
  cluster: { heading: "Cluster", sub: "P3.", cta: "Create" },
  image: { heading: "Image", sub: "P3.", cta: "Create" },
};

export default function Sidebar() {
  const selectedId = useGraphStore((s) => s.selectedNodeId);
  const node = useGraphStore((s) =>
    selectedId ? s.nodes.find((n) => n.id === selectedId) : undefined,
  );
  const draftType = useGraphStore((s) => s.draftType);
  const workspaceId = useGraphStore((s) => s.workspaceId);
  const upsertNode = useGraphStore((s) => s.upsertNode);
  const removeNode = useGraphStore((s) => s.removeNode);
  const selectNode = useGraphStore((s) => s.selectNode);
  const cancelDraft = useGraphStore((s) => s.cancelDraft);
  const setEdges = useGraphStore((s) => s.setEdges);

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
      .then(async (res) => {
        setIndexStatus("indexed");
        setChunkCount(res.chunks_created);
        // Auto-connect once new chunks exist — keeps the graph fresh without
        // requiring the user to remember to click the button.
        if (node?.workspace_id) {
          try {
            await api(`/workspaces/${node.workspace_id}/rebuild-edges`, {
              method: "POST",
            });
            const fresh = await db.listEdges(node.workspace_id);
            setEdges(fresh);
          } catch (e) {
            console.warn("auto-connect after embed failed", e);
          }
        }
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

  if (draftType && workspaceId) {
    return (
      <DraftForm
        type={draftType}
        workspaceId={workspaceId}
        onCreated={(newNode) => {
          upsertNode(newNode);
          selectNode(newNode.id);
        }}
        onCancel={cancelDraft}
        setEdges={setEdges}
      />
    );
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
    <aside className="flex h-full flex-col border-l border-palace-edge bg-palace-panel/95 shadow-2xl backdrop-blur-md">
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
        {/* Inline media preview — YouTube embed, PDF iframe, image, etc.
            Renders nothing for plain notes with no detectable media. */}
        <MediaPreview node={node} upload={upload} />

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
              onProcessed={async () => {
                // Refresh upload + chunk count, then auto-connect the graph
                // since new chunks just landed.
                await refreshState();
                if (node.workspace_id) {
                  try {
                    await api(
                      `/workspaces/${node.workspace_id}/rebuild-edges`,
                      { method: "POST" },
                    );
                    const fresh = await db.listEdges(node.workspace_id);
                    setEdges(fresh);
                  } catch (e) {
                    console.warn("auto-connect after ingest failed", e);
                  }
                }
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

/**
 * Type-aware new-node form rendered inside the sidebar slot.
 * Submitting persists the node, selects it (which transitions the sidebar
 * to edit-mode), then fires embed + auto-connect in the background.
 */
function DraftForm({
  type,
  workspaceId,
  onCreated,
  onCancel,
  setEdges,
}: {
  type: NodeType;
  workspaceId: string;
  onCreated: (n: db.DbNode) => void;
  onCancel: () => void;
  setEdges: (edges: db.DbEdge[]) => void;
}) {
  const copy = DRAFT_COPY[type];
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [url, setUrl] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const titleRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    titleRef.current?.focus();
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    setSaving(true);
    setError(null);
    try {
      let assembledContent = content.trim();
      if (type === "url") {
        const u = url.trim();
        assembledContent = assembledContent ? `${u}\n\n${assembledContent}` : u;
      }

      const node = await db.createNode({
        workspace_id: workspaceId,
        type,
        title: title.trim(),
        content: assembledContent,
        x: 0,
        y: 0,
      });
      onCreated(node);

      // Background: embed (if there's content) → auto-connect → refresh edges.
      if ((type === "note" || type === "url") && assembledContent) {
        try {
          await api(`/nodes/${node.id}/embed`, { method: "POST" });
          await api(`/workspaces/${workspaceId}/rebuild-edges`, {
            method: "POST",
          });
          const fresh = await db.listEdges(workspaceId);
          setEdges(fresh);
        } catch (e) {
          console.warn("post-create embed/auto-connect failed", e);
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSaving(false);
    }
  }

  return (
    <aside className="flex h-full flex-col border-l border-palace-edge bg-palace-panel/95 shadow-2xl backdrop-blur-md">
      <header className="border-b border-palace-edge p-4">
        <div className="text-[10px] font-semibold uppercase tracking-wider text-palace-accent">
          DRAFT · {type}
        </div>
        <div className="mt-1 text-base font-semibold text-neutral-100">
          {copy.heading}
        </div>
        <div className="mt-1 text-xs text-neutral-500">{copy.sub}</div>
      </header>

      <form onSubmit={submit} className="flex flex-1 flex-col">
        <div className="flex-1 space-y-3 overflow-auto p-4">
          <label className="block text-xs font-medium text-neutral-400">
            Title
            <input
              ref={titleRef}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={
                type === "doc"
                  ? "e.g. attention is all you need"
                  : type === "url"
                    ? "e.g. RFC 7159 (JSON spec)"
                    : "e.g. interview notes"
              }
              className="mt-1 w-full rounded-lg bg-palace-bg px-3 py-2 text-sm text-neutral-100 outline-none ring-1 ring-palace-edge focus:ring-palace-accent"
            />
          </label>

          {type === "url" && (
            <label className="block text-xs font-medium text-neutral-400">
              URL
              <input
                type="url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://..."
                className="mt-1 w-full rounded-lg bg-palace-bg px-3 py-2 text-sm text-neutral-100 outline-none ring-1 ring-palace-edge focus:ring-palace-accent"
              />
            </label>
          )}

          {type !== "doc" && (
            <label className="block text-xs font-medium text-neutral-400">
              {type === "url" ? "Notes (optional)" : "Content"}
              <textarea
                value={content}
                onChange={(e) => setContent(e.target.value)}
                rows={type === "url" ? 4 : 10}
                placeholder={
                  type === "url"
                    ? "Why this URL matters, what to remember about it..."
                    : "What's on your mind?"
                }
                className="mt-1 w-full resize-none rounded-lg bg-palace-bg px-3 py-2 text-sm text-neutral-100 outline-none ring-1 ring-palace-edge focus:ring-palace-accent"
              />
            </label>
          )}

          {type === "doc" && (
            <p className="rounded-md bg-palace-bg/70 p-3 text-xs text-neutral-500 ring-1 ring-palace-edge">
              Once created, you&rsquo;ll see a file-upload area here. Pick a
              PDF or text file — it&rsquo;ll be chunked, embedded, and
              auto-connected to related nodes.
            </p>
          )}

          {error && (
            <p className="rounded-md bg-red-950/40 px-3 py-2 text-xs text-red-300">
              {error}
            </p>
          )}
        </div>

        <footer className="flex items-center justify-end gap-2 border-t border-palace-edge p-4">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-lg px-3 py-1.5 text-xs text-neutral-400 ring-1 ring-palace-edge hover:bg-palace-bg"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={saving || !title.trim() || (type === "url" && !url.trim())}
            className="rounded-lg bg-palace-accent px-4 py-1.5 text-xs font-medium text-white hover:bg-palace-accent/90 disabled:opacity-50"
          >
            {saving ? "..." : copy.cta}
          </button>
        </footer>
      </form>
    </aside>
  );
}
