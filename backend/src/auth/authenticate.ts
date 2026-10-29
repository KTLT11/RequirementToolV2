import type { NextFunction, Request, Response } from "express";
import { HttpError } from "../http/errors.js";
import { readSessionCookie } from "./cookies.js";
import { findValidSession } from "./sessions.js";
import { findUserById, type AppUser } from "./users.js";

// Augment Express's Request type so every downstream handler can read
// req.user without a cast. Populated only by authenticate() below -
// never set from any other code path, and never from client-supplied
// data (body/query/header) directly.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AppUser;
    }
  }
}

/**
 * Resolves the session cookie to a live app_users row and attaches it
 * as req.user. Throws UNAUTHENTICATED (caught by the central error
 * handler) if there is no cookie, the session is missing/expired/
 * revoked, or the user it points to no longer exists or is inactive.
 *
 * This is the ONLY place a request's identity is established. Every
 * other check (authorize.ts, route handlers) relies on req.user
 * having already been validated here - none of them re-check the
 * cookie or re-trust anything the client sent.
 */
export async function authenticate(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const sessionId = readSessionCookie(req);
    if (!sessionId) {
      throw new HttpError("UNAUTHENTICATED", "No session cookie present");
    }

    const session = await findValidSession(sessionId);
    if (!session) {
      throw new HttpError("UNAUTHENTICATED", "Session is invalid or expired");
    }

    const user = await findUserById(session.userId);
    if (!user || !user.isActive) {
      throw new HttpError("UNAUTHENTICATED", "Session user is no longer valid");
    }

    req.user = user;
    next();
  } catch (err) {
    next(err);
  }
}
