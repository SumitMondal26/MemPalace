import { redirect } from "next/navigation";
import { supabaseServer } from "@/lib/supabase-server";

export default async function Home() {
  const sb = await supabaseServer();
  const {
    data: { user },
  } = await sb.auth.getUser();
  redirect(user ? "/graph" : "/login");
}
