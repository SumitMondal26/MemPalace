import { redirect } from "next/navigation";

import { supabaseServer } from "@/lib/supabase-server";
import InsightsClient from "./InsightsClient";

/**
 * /insights — AI observability dashboard.
 *
 * Server-renders the last 100 chat_logs rows for the signed-in user (RLS
 * scopes to their workspace). The client component handles list selection,
 * drill-down, and aggregate stats over the loaded set.
 */
export default async function InsightsPage() {
  const sb = await supabaseServer();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) redirect("/login");

  const { data: logs } = await sb
    .from("chat_logs")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(100);

  return (
    <InsightsClient
      userEmail={user.email ?? "(no email)"}
      logs={logs ?? []}
    />
  );
}
