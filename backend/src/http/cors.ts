import type { NextFunction, Request, Response } from "express";

// A small hand-written CORS middleware instead of pulling in the
// `cors` package - the actual logic needed here (one fixed, explicit
// origin, credentials allowed, a short OPTIONS preflight response) is
// a few lines and doesn't need a general-purpose configurable library
// on top of it.
//
// CORS_ORIGIN must be set to exactly the frontend's origin (e.g.
// http://localhost:5173) - "*" is rejected outright because a
// wildcard origin is incompatible with credentialed requests per the
// Fetch spec (browsers refuse to expose the response to a page whose
// request included credentials if Access-Control-Allow-Origin is "*"),
// and because allowing any origin to send cookies would defeat the
// whole point of an HttpOnly session cookie.
//
// Validated lazily, inside the middleware function rather than at
// module load - so importing app.ts (e.g. from a unit test that
// never actually sends an HTTP request) doesn't require CORS_ORIGIN
// to be set, the same reasoning as pool.ts's lazy getPool().
export function corsMiddleware(req: Request, res: Response, next: NextFunction): void {
  const allowedOrigin = process.env.CORS_ORIGIN;
  if (!allowedOrigin || allowedOrigin === "*") {
    next(
      new Error(
        'CORS_ORIGIN must be set to a single explicit origin (e.g. "http://localhost:5173"), never unset or "*", because requests carry credentials (the session cookie).',
      ),
    );
    return;
  }

  const requestOrigin = req.headers.origin;
  if (requestOrigin === allowedOrigin) {
    res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Vary", "Origin");
  }
  // If requestOrigin doesn't match, no CORS headers are set at all -
  // the browser's own same-origin policy then blocks the response
  // from being read by that other origin's script, same effect as
  // an explicit deny would have.

  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.status(204).end();
    return;
  }

  next();
}
