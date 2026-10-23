import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";

/**
 * Creates a Supabase client scoped to the caller's own JWT, so every
 * query runs under that user's identity and is subject to RLS exactly
 * as PostgREST would apply it. Never uses service_role here - reads
 * must stay within the same authorization boundary as the caller.
 */
export function createUserScopedClient(bearerToken: string): SupabaseClient {
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");

  if (!supabaseUrl || !anonKey) {
    throw new Error(
      "Missing SUPABASE_URL or SUPABASE_ANON_KEY in function environment",
    );
  }

  return createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: `Bearer ${bearerToken}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
