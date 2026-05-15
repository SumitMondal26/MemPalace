/**
 * Thin Supabase data layer. One file holds every table read/write so the
 * shape of our DB queries lives in one place.
 *
 * All calls go through the browser client → RLS enforces tenancy.
 */

import { supabase } from "./supabase";

export type NodeType = "note" | "doc" | "image" | "url" | "cluster";

export type DbNode = {
  id: string;
  workspace_id: string;
  type: NodeType;
  title: string | null;
  content: string | null;
  metadata: Record<string, unknown>;
  /** FK into clusters.id, or null when this node hasn't been clustered yet
   *  (brand-new, or workspace never ran "Recompute topics"). */
  cluster_id: string | null;
  x: number;
  y: number;
  created_at: string;
  updated_at: string;
};

export type DbCluster = {
  id: string;
  workspace_id: string;
  label: string;
  color: string | null;
  created_at: string;
};

export type DbEdge = {
  id: string;
  workspace_id: string;
  source_id: string;
  target_id: string;
  kind: "manual" | "semantic";
  weight: number;
  created_at: string;
};

export type UploadStatus = "pending" | "processed" | "failed";

export type DbUpload = {
  id: string;
  node_id: string;
  storage_path: string;
  mime_type: string | null;
  status: UploadStatus;
  created_at: string;
};

// ---------------------------------------------------------------------------
// Workspaces
// ---------------------------------------------------------------------------

export async function getCurrentWorkspace() {
  const { data, error } = await supabase()
    .from("workspaces")
    .select("id, name")
    .order("created_at", { ascending: true })
    .limit(1)
    .single();
  if (error) throw error;
  return data;
}

// ---------------------------------------------------------------------------
// Nodes
// ---------------------------------------------------------------------------

export async function listNodes(workspaceId: string): Promise<DbNode[]> {
  const { data, error } = await supabase()
    .from("nodes")
    .select("*")
    .eq("workspace_id", workspaceId);
  if (error) throw error;
  return data as DbNode[];
}

export async function createNode(input: {
  workspace_id: string;
  type: NodeType;
  title?: string;
  content?: string;
  x?: number;
  y?: number;
}): Promise<DbNode> {
  const { data, error } = await supabase()
    .from("nodes")
    .insert(input)
    .select()
    .single();
  if (error) throw error;
  return data as DbNode;
}

export async function updateNode(
  id: string,
  patch: Partial<Pick<DbNode, "title" | "content" | "x" | "y" | "metadata">>,
): Promise<DbNode> {
  const { data, error } = await supabase()
    .from("nodes")
    .update(patch)
    .eq("id", id)
    .select()
    .single();
  if (error) throw error;
  return data as DbNode;
}

export async function deleteNode(id: string): Promise<void> {
  const { error } = await supabase().from("nodes").delete().eq("id", id);
  if (error) throw error;
}

// ---------------------------------------------------------------------------
// Edges
// ---------------------------------------------------------------------------

export async function listEdges(workspaceId: string): Promise<DbEdge[]> {
  const { data, error } = await supabase()
    .from("edges")
    .select("*")
    .eq("workspace_id", workspaceId);
  if (error) throw error;
  return data as DbEdge[];
}

export async function createEdge(input: {
  workspace_id: string;
  source_id: string;
  target_id: string;
  kind?: DbEdge["kind"];
}): Promise<DbEdge> {
  const payload = { kind: "manual" as const, ...input };
  const { data, error } = await supabase()
    .from("edges")
    .insert(payload)
    .select()
    .single();
  if (error) throw error;
  return data as DbEdge;
}

export async function deleteEdge(id: string): Promise<void> {
  const { error } = await supabase().from("edges").delete().eq("id", id);
  if (error) throw error;
}

// ---------------------------------------------------------------------------
// Clusters (LLM-named topic groupings — see services/clustering.py)
// ---------------------------------------------------------------------------

export async function listClusters(workspaceId: string): Promise<DbCluster[]> {
  const { data, error } = await supabase()
    .from("clusters")
    .select("*")
    .eq("workspace_id", workspaceId);
  if (error) throw error;
  return data as DbCluster[];
}

// ---------------------------------------------------------------------------
// Per-node state lookups (for the Sidebar to surface "what's already there")
// ---------------------------------------------------------------------------

export async function getNodeChunkCount(nodeId: string): Promise<number> {
  const { count, error } = await supabase()
    .from("chunks")
    .select("id", { count: "exact", head: true })
    .eq("node_id", nodeId);
  if (error) throw error;
  return count ?? 0;
}

/**
 * Mint a short-lived signed URL for a private storage object so the
 * browser can render it inline (PDF iframe, image src, etc.). RLS still
 * applies on the row that *links* to the storage path; storage objects
 * themselves are protected by signed-URL expiry.
 *
 * Default 1h expiry — long enough for the user to read a PDF without
 * the iframe going stale, short enough that the link is useless if
 * leaked. Bump to 24h via the `expiresIn` arg if needed.
 */
export async function createUploadSignedUrl(
  storagePath: string,
  expiresIn: number = 3600,
): Promise<string | null> {
  const { data, error } = await supabase()
    .storage.from("uploads")
    .createSignedUrl(storagePath, expiresIn);
  if (error || !data?.signedUrl) return null;
  return data.signedUrl;
}

export async function getLatestUpload(
  nodeId: string,
): Promise<DbUpload | null> {
  const { data, error } = await supabase()
    .from("uploads")
    .select("*")
    .eq("node_id", nodeId)
    .order("created_at", { ascending: false })
    .limit(1);
  if (error) throw error;
  return (data?.[0] as DbUpload) ?? null;
}

/** Strip the upload-time prefix (epoch-millis-) from a stored path. */
export function filenameFromStoragePath(path: string): string {
  const last = path.split("/").pop() ?? path;
  return last.replace(/^\d+-/, "");
}
