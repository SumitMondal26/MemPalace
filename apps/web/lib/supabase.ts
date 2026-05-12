import { createBrowserClient } from "@supabase/ssr";

/**
 * Browser-side Supabase client. Reads cookies for the session automatically.
 * For server components we'll add createServerClient() in step 6 when we
 * wire auth-aware SSR.
 */
export function supabase() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );
}
