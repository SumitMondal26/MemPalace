"use client";

import { useState } from "react";

import { api } from "@/lib/api";
import type { DbUpload } from "@/lib/db";
import { filenameFromStoragePath } from "@/lib/db";
import { supabase } from "@/lib/supabase";

type Status = "idle" | "uploading" | "processing" | "done" | "error";

type IngestResponse = { chunks_created: number; total_tokens: number };

type Props = {
  nodeId: string;
  /** Pre-existing upload row, if the node already has one ingested. */
  existing?: DbUpload | null;
  /** Chunks already in the DB for this node (for display). */
  existingChunkCount?: number;
  /** Called after a successful ingest so the parent can refetch state. */
  onProcessed?: (chunks: number) => void;
};

export default function UploadDropzone({
  nodeId,
  existing,
  existingChunkCount,
  onProcessed,
}: Props) {
  const [status, setStatus] = useState<Status>("idle");
  const [message, setMessage] = useState<string>("");
  const [result, setResult] = useState<IngestResponse | null>(null);

  const hasExisting =
    !!existing && existing.status === "processed" && status === "idle";

  async function handleFile(file: File) {
    setStatus("uploading");
    setResult(null);
    setMessage(file.name);

    const sb = supabase();
    const {
      data: { user },
    } = await sb.auth.getUser();
    if (!user) {
      setStatus("error");
      setMessage("not signed in");
      return;
    }

    const path = `${user.id}/${nodeId}/${Date.now()}-${file.name}`;
    const { error: upErr } = await sb.storage
      .from("uploads")
      .upload(path, file, { upsert: false });
    if (upErr) {
      setStatus("error");
      setMessage(`upload failed: ${upErr.message}`);
      return;
    }

    setStatus("processing");
    try {
      const data = await api<IngestResponse>("/ingest", {
        method: "POST",
        body: JSON.stringify({
          node_id: nodeId,
          storage_path: path,
          mime_type: file.type || null,
        }),
      });
      setResult(data);
      setStatus("done");
      onProcessed?.(data.chunks_created);
    } catch (e) {
      setStatus("error");
      setMessage(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div className="space-y-2">
      {hasExisting && existing && (
        <div className="rounded-lg bg-palace-bg p-3 ring-1 ring-palace-edge">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-neutral-500">
            Current file
          </div>
          <div
            className="mt-1 truncate text-sm text-neutral-200"
            title={existing.storage_path}
          >
            {filenameFromStoragePath(existing.storage_path)}
          </div>
          <div className="mt-1 flex items-center gap-2 text-[11px] text-neutral-500">
            <span className="text-emerald-400">
              ✓ {existingChunkCount ?? "?"} chunks indexed
            </span>
            <span>·</span>
            <span>uploaded {new Date(existing.created_at).toLocaleString()}</span>
          </div>
        </div>
      )}

      <label
        className={[
          "block cursor-pointer rounded-lg border-2 border-dashed p-5 text-center text-sm transition",
          status === "error"
            ? "border-red-700 text-red-300"
            : "border-palace-edge text-neutral-400 hover:border-palace-accent hover:text-neutral-200",
        ].join(" ")}
      >
        <input
          type="file"
          accept=".pdf,.txt,.md,application/pdf,text/plain"
          disabled={status === "uploading" || status === "processing"}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) handleFile(f);
            e.target.value = "";
          }}
          className="hidden"
        />
        {status === "idle" && (
          <>
            <p className="font-medium">
              {hasExisting ? "Click to replace file" : "Click to upload a file"}
            </p>
            <p className="mt-1 text-xs text-neutral-500">
              PDF, .txt, .md — chunked + embedded for retrieval
            </p>
          </>
        )}
        {status === "uploading" && (
          <p>
            Uploading <span className="text-neutral-300">{message}</span>…
          </p>
        )}
        {status === "processing" && <p>Extracting → chunking → embedding…</p>}
        {status === "done" && result && (
          <p className="text-emerald-400">
            ✓ {result.chunks_created} chunks · {result.total_tokens} tokens
          </p>
        )}
        {status === "error" && <p>{message}</p>}
      </label>
      {status === "done" && (
        <p className="text-xs text-neutral-500">
          Old chunks were replaced. Re-upload anytime to refresh.
        </p>
      )}
    </div>
  );
}
