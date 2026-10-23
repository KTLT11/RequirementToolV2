import { createClient, type User } from "jsr:@supabase/supabase-js@2";
import { errorResponse } from "./responses.ts";

export interface AuthenticatedBA {
  user: User;
  rtRole: string;
}

export type AuthFailure =
  | { ok: false; status: 401; reason: string }
  | { ok: false; status: 403; reason: string };

export type AuthResult =
  | { ok: true; context: AuthenticatedBA }
  | AuthFailure;

/**
 * Converts a failed requireBA() result into the standard error
 * response contract. Keeps the 401/403 mapping in one place so
 * every Edge Function returns the same shape without re-deriving it.
 */
export function errorResponseFromAuth(failure: AuthFailure): Response {
  return failure.status === 401
    ? errorResponse("UNAUTHENTICATED", failure.reason)
    : errorResponse("FORBIDDEN", failure.reason);
}

export function getBearerToken(req: Request): string | null {
  const header = req.headers.get("Authorization");
  if (!header) return null;
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : null;
}

/**
 * Verifies the caller's JWT against Supabase Auth and requires
 * app_metadata.rt_role === "BA". Uses the anon key + the caller's
 * own token (not service_role) so this check carries no elevated
 * privileges beyond what the token itself grants.
 */
export async function requireBA(req: Request): Promise<AuthResult> {
  const token = getBearerToken(req);
  if (!token) {
    return { ok: false, status: 401, reason: "Missing bearer token" };
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  if (!supabaseUrl || !anonKey) {
    throw new Error(
      "Missing SUPABASE_URL or SUPABASE_ANON_KEY in function environment",
    );
  }

  const client = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data, error } = await client.auth.getUser(token);

  if (error || !data?.user) {
    return { ok: false, status: 401, reason: "Invalid or expired token" };
  }

  const rtRole = (data.user.app_metadata as Record<string, unknown> | null)
    ?.rt_role;

  if (rtRole !== "BA") {
    return { ok: false, status: 403, reason: "Caller is not a BA" };
  }

  return {
    ok: true,
    context: { user: data.user, rtRole },
  };
}
