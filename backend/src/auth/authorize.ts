import type { NextFunction, Request, Response } from "express";
import { HttpError } from "../http/errors.js";

/**
 * The single extension point for authorization. At MVP there is
 * exactly one role (BA), so this is a flat equality check - but it
 * is kept as its own module, separate from route handlers and from
 * authenticate.ts, specifically so that adding a second role or
 * per-Case permissions later only means changing this file (e.g.
 * accepting a caseId and checking a case_stakeholders-style
 * relationship) rather than touching every route.
 *
 * Must run after authenticate() - relies on req.user already being
 * set from a validated session, never from client-supplied input.
 */
export function requireRole(role: string) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.user) {
      // Programmer error if this fires - authenticate() should always
      // run first and either populate req.user or short-circuit with
      // UNAUTHENTICATED before this middleware is ever reached.
      next(new HttpError("UNAUTHENTICATED", "No authenticated user on request"));
      return;
    }

    if (req.user.rtRole !== role) {
      next(new HttpError("FORBIDDEN", `Requires role ${role}`));
      return;
    }

    next();
  };
}
