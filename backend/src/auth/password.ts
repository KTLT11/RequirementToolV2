import * as argon2 from "argon2";

/**
 * Verifies a plaintext password against an Argon2id hash stored in
 * app_users.password_hash. Never throws on a wrong password — argon2
 * itself distinguishes "wrong password" (resolves false) from a
 * genuinely malformed/corrupt hash (throws), and callers should treat
 * both the same way (reject the login) rather than leaking which one
 * occurred.
 */
export async function verifyPassword(
  hash: string,
  plaintext: string,
): Promise<boolean> {
  try {
    return await argon2.verify(hash, plaintext);
  } catch {
    return false;
  }
}
