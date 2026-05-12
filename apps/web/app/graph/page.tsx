import { redirect } from "next/navigation";

import { supabaseServer } from "@/lib/supabase-server";
import type { DbEdge, DbNode } from "@/lib/db";
import GraphPageClient from "./GraphPageClient";

/**
 * Server-rendered first paint: load the user's workspace + initial nodes/edges
 * server-side, hand them down as props. Avoids the "empty canvas → spinner →
 * graph appears" flash on cold load.
 */
export default async function GraphPage() {
  const sb = await supabaseServer();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) redirect("/login");

  // Auto-created by the on_auth_user_created trigger.
  const { data: workspaces } = await sb
    .from("workspaces")
    .select("id, name")
    .order("created_at", { ascending: true })
    .limit(1);

  const workspace = workspaces?.[0];
  if (!workspace) {
    // Trigger didn't fire (shouldn't happen for fresh signups).
    redirect("/login");
  }

  const [nodesRes, edgesRes] = await Promise.all([
    sb.from("nodes").select("*").eq("workspace_id", workspace.id),
    sb.from("edges").select("*").eq("workspace_id", workspace.id),
  ]);

  return (
    <GraphPageClient
      userEmail={user.email ?? "(no email)"}
      workspaceId={workspace.id}
      workspaceName={workspace.name}
      initialNodes={(nodesRes.data ?? []) as DbNode[]}
      initialEdges={(edgesRes.data ?? []) as DbEdge[]}
    />
  );
}
