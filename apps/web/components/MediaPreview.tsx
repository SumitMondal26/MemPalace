"use client";

import { useEffect, useState } from "react";

import { createUploadSignedUrl } from "@/lib/db";
import type { DbNode, DbUpload } from "@/lib/db";

/**
 * MediaPreview — inline media rendering for a node, shown in the sidebar.
 *
 * Why not in hover tooltips: hover should be cheap + text-only. iframes
 * + signed URL roundtrips on every mouse pass would be jarring and waste
 * Storage egress. Sidebar fires only on intentional click, has space,
 * and a steady focus.
 *
 * Detection:
 *   - doc + image mime          → <img>
 *   - doc + application/pdf     → <iframe> with signed-URL src
 *   - doc + other               → file chip with download link
 *   - url / note containing URL → see _detectUrlMedia()
 *
 * If we can't render anything useful (e.g. note with no URL), we render
 * nothing — caller decides whether to show a placeholder.
 */
export default function MediaPreview({
  node,
  upload,
}: {
  node: DbNode;
  upload: DbUpload | null;
}) {
  const docRender = useDocPreviewSrc(node, upload);

  // doc nodes — uploaded files. Render based on mime.
  if (node.type === "doc" && upload && docRender.src) {
    if (upload.mime_type?.startsWith("image/")) {
      return (
        <Frame label={filename(upload.storage_path)}>
          <img
            src={docRender.src}
            alt={node.title || "image"}
            className="max-h-[360px] w-full rounded object-contain bg-black"
          />
        </Frame>
      );
    }
    if (upload.mime_type === "application/pdf") {
      return (
        <Frame label={filename(upload.storage_path)}>
          <iframe
            src={docRender.src}
            className="h-[360px] w-full rounded bg-neutral-950"
            title={node.title || "pdf"}
          />
        </Frame>
      );
    }
    // Other file types — link only.
    return (
      <Frame label={filename(upload.storage_path)}>
        <a
          href={docRender.src}
          target="_blank"
          rel="noreferrer"
          className="block rounded bg-palace-bg px-3 py-2 text-xs text-palace-accent hover:underline"
        >
          Open file ↗
        </a>
      </Frame>
    );
  }

  // url + note nodes that contain a URL.
  if (node.type === "url" || node.type === "note") {
    const url = firstUrl(node.content || "");
    if (url) {
      const media = detectUrlMedia(url);
      switch (media.kind) {
        case "youtube":
          return (
            <Frame label={hostname(url)}>
              <div className="aspect-video w-full overflow-hidden rounded bg-black">
                <iframe
                  src={`https://www.youtube.com/embed/${media.videoId}`}
                  className="h-full w-full"
                  allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                  allowFullScreen
                  title={node.title || "youtube video"}
                />
              </div>
              <a
                href={url}
                target="_blank"
                rel="noreferrer"
                className="mt-1 block truncate text-[10px] text-neutral-500 hover:text-palace-accent"
              >
                {url}
              </a>
            </Frame>
          );
        case "vimeo":
          return (
            <Frame label={hostname(url)}>
              <div className="aspect-video w-full overflow-hidden rounded bg-black">
                <iframe
                  src={`https://player.vimeo.com/video/${media.videoId}`}
                  className="h-full w-full"
                  allow="autoplay; fullscreen; picture-in-picture"
                  allowFullScreen
                  title={node.title || "vimeo video"}
                />
              </div>
            </Frame>
          );
        case "image":
          return (
            <Frame label={hostname(url)}>
              <img
                src={url}
                alt={node.title || "image"}
                className="max-h-[360px] w-full rounded object-contain bg-black"
              />
            </Frame>
          );
        case "pdf":
          return (
            <Frame label={hostname(url)}>
              <iframe
                src={url}
                className="h-[360px] w-full rounded bg-neutral-950"
                title={node.title || "pdf"}
              />
            </Frame>
          );
        case "generic":
          // Most sites set X-Frame-Options to deny iframe embedding, so we
          // don't try. A clean link card is more honest than a broken iframe.
          return (
            <Frame label={hostname(url)}>
              <a
                href={url}
                target="_blank"
                rel="noreferrer"
                className="block rounded bg-palace-bg px-3 py-2 text-xs text-palace-accent hover:underline"
              >
                Open ↗
              </a>
            </Frame>
          );
      }
    }
  }

  return null;
}

/** Lightweight wrapper card around any preview. */
function Frame({ children, label }: { children: React.ReactNode; label: string }) {
  return (
    <div className="space-y-1">
      <div className="text-[9px] font-semibold uppercase tracking-wider text-neutral-500">
        {label}
      </div>
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the storage path → signed URL for doc nodes. Returns the URL
 * once minted; null while loading or on failure (caller falls back to
 * not rendering the embed).
 *
 * Re-runs whenever the upload's storage_path changes (replace-file flow).
 */
function useDocPreviewSrc(node: DbNode, upload: DbUpload | null) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    if (node.type !== "doc" || !upload?.storage_path) {
      setSrc(null);
      return;
    }
    let cancelled = false;
    createUploadSignedUrl(upload.storage_path).then((url) => {
      if (!cancelled) setSrc(url);
    });
    return () => {
      cancelled = true;
    };
  }, [node.type, upload?.storage_path]);
  return { src };
}

const URL_RE = /https?:\/\/[^\s<>\)\]\}\,]+/i;

function firstUrl(text: string): string | null {
  const m = text.match(URL_RE);
  return m ? m[0] : null;
}

function hostname(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function filename(storagePath: string): string {
  const last = storagePath.split("/").pop() ?? storagePath;
  // Stored as "<epoch_ms>-<original>" — strip the epoch prefix for display.
  return last.replace(/^\d+-/, "");
}

type UrlMedia =
  | { kind: "youtube"; videoId: string }
  | { kind: "vimeo"; videoId: string }
  | { kind: "image" }
  | { kind: "pdf" }
  | { kind: "generic" };

/**
 * Identify what kind of media is at this URL by inspecting hostname + path.
 * No HEAD request — keeps the preview synchronous and avoids CORS pain.
 */
function detectUrlMedia(url: string): UrlMedia {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { kind: "generic" };
  }
  const host = parsed.hostname.replace(/^www\./, "");
  const path = parsed.pathname.toLowerCase();

  // YouTube — both watch?v= and youtu.be/ID forms.
  if (host === "youtube.com" || host === "m.youtube.com") {
    const v = parsed.searchParams.get("v");
    if (v) return { kind: "youtube", videoId: v };
    const shorts = path.match(/^\/shorts\/([\w-]+)/);
    if (shorts) return { kind: "youtube", videoId: shorts[1] };
  }
  if (host === "youtu.be") {
    const id = path.replace(/^\//, "").split("/")[0];
    if (id) return { kind: "youtube", videoId: id };
  }

  // Vimeo — vimeo.com/<digits>
  if (host === "vimeo.com") {
    const m = path.match(/^\/(\d+)/);
    if (m) return { kind: "vimeo", videoId: m[1] };
  }

  // PDF + image extensions in the path. Trailing query/hash already trimmed
  // by `path` (we used pathname, not href).
  if (/\.(jpe?g|png|gif|webp|avif|svg|bmp)$/i.test(path)) return { kind: "image" };
  if (/\.pdf$/i.test(path)) return { kind: "pdf" };

  return { kind: "generic" };
}
