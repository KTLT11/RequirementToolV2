import { getPool } from "../db/pool.js";

export interface AppUser {
  userId: string;
  email: string;
  passwordHash: string;
  rtRole: string;
  displayName: string | null;
  isActive: boolean;
}

function mapRow(row: {
  user_id: string;
  email: string;
  password_hash: string;
  rt_role: string;
  display_name: string | null;
  is_active: boolean;
}): AppUser {
  return {
    userId: row.user_id,
    email: row.email,
    passwordHash: row.password_hash,
    rtRole: row.rt_role,
    displayName: row.display_name,
    isActive: row.is_active,
  };
}

export async function findUserByEmail(email: string): Promise<AppUser | null> {
  const { rows } = await getPool().query(
    `SELECT user_id, email, password_hash, rt_role, display_name, is_active
     FROM app_users
     WHERE email = $1`,
    [email],
  );
  return rows[0] ? mapRow(rows[0]) : null;
}

/**
 * Looks up a user by id for authorization decisions - always called
 * with the userId resolved from a validated session (sessions.ts),
 * never with an id taken directly from client input. This is what
 * makes authorize.ts's role check trustworthy: rt_role is re-read
 * from the database on every request, not cached in the cookie/token.
 */
export async function findUserById(userId: string): Promise<AppUser | null> {
  const { rows } = await getPool().query(
    `SELECT user_id, email, password_hash, rt_role, display_name, is_active
     FROM app_users
     WHERE user_id = $1`,
    [userId],
  );
  return rows[0] ? mapRow(rows[0]) : null;
}
