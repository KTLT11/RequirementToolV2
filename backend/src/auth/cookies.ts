import { serialize, parse } from "cookie";
import type { Request, Response } from "express";

export const SESSION_COOKIE_NAME = "rt_session";

// Secure is conditional on actually running behind HTTPS, not
// hardcoded true - a hardcoded true would silently break local HTTP
// development (browsers drop Secure cookies over plain HTTP), and a
// hardcoded false would ship an insecure cookie to production.
// NODE_ENV=production is the deployment signal already used
// everywhere else, not a new flag invented for this one purpose.
const isProduction = process.env.NODE_ENV === "production";

export function setSessionCookie(
  res: Response,
  sessionId: string,
  expiresAt: Date,
): void {
  const cookie = serialize(SESSION_COOKIE_NAME, sessionId, {
    httpOnly: true,
    secure: isProduction,
    sameSite: "lax",
    // "lax" (not "strict") because this is the BA's own first-party
    // app, not an embedded/cross-site widget - "strict" would also
    // drop the cookie on a plain top-level navigation from an
    // external link into the app, which "lax" still allows while
    // still blocking cross-site POST/fetch use of the cookie.
    path: "/",
    expires: expiresAt,
  });
  res.appendHeader("Set-Cookie", cookie);
}

export function clearSessionCookie(res: Response): void {
  const cookie = serialize(SESSION_COOKIE_NAME, "", {
    httpOnly: true,
    secure: isProduction,
    sameSite: "lax",
    path: "/",
    expires: new Date(0),
  });
  res.appendHeader("Set-Cookie", cookie);
}

export function readSessionCookie(req: Request): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  const parsed = parse(header);
  return parsed[SESSION_COOKIE_NAME] ?? null;
}
