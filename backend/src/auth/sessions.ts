import { randomUUID } from "node:crypto";
import { getPool } from "../db/pool.js";

// Session lifetime is deliberately explicit and short-ish for an MVP
// with a single trusted BA account - not configurable per-request,
// not read from any client input.
const SESSION_LIFETIME_MS = 12 * 60 * 60 * 1000; // 12 hours

export interface SessionRecord {
  sessionId: string;
  userId: string;
  expiresAt: Date;
}

/**
 * Creates a new session row for userId and returns its id + expiry.
 * The returned sessionId is what gets put in the cookie - callers
 * must not construct their own id, since app_sessions.session_id is
 * the only value that authenticate() will ever accept back.
 */
export async function createSession(userId: string): Promise<SessionRecord> {
  const sessionId = randomUUID();
  const expiresAt = new Date(Date.now() + SESSION_LIFETIME_MS);

  await getPool().query(
    `INSERT INTO app_sessions (session_id, user_id, expires_at)
     VALUES ($1, $2, $3)`,
    [sessionId, userId, expiresAt],
  );

  return { sessionId, userId, expiresAt };
}

/**
 * Looks up a session by id. Returns null if the session does not
 * exist, has expired, or was revoked (logout) - callers should treat
 * all three identically as "not authenticated", never distinguish
 * them in the response (doing so would leak whether a given session
 * id was ever valid).
 */
export async function findValidSession(
  sessionId: string,
): Promise<{ userId: string } | null> {
  const { rows } = await getPool().query<{ user_id: string }>(
    `SELECT user_id FROM app_sessions
     WHERE session_id = $1
       AND revoked_at IS NULL
       AND expires_at > now()`,
    [sessionId],
  );

  return rows[0] ? { userId: rows[0].user_id } : null;
}

/**
 * Revokes a session immediately (logout). Idempotent - revoking an
 * already-revoked or nonexistent session is not an error, since
 * logout should always succeed from the client's point of view.
 */
export async function revokeSession(sessionId: string): Promise<void> {
  await getPool().query(
    `UPDATE app_sessions SET revoked_at = now()
     WHERE session_id = $1 AND revoked_at IS NULL`,
    [sessionId],
  );
}
