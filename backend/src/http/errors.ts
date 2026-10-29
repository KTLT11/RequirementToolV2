// Error contract shared by every route. Deliberately mirrors the
// shape the old Edge Function used (supabase/functions/_shared/
// responses.ts) — same error codes, same { error: { code, message } }
// envelope — so the frontend's existing error handling keeps working
// unchanged across the cutover from Edge Functions to this backend.

export type ErrorCode =
  | "VALIDATION_ERROR"
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "INTERNAL_ERROR";

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  VALIDATION_ERROR: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  INTERNAL_ERROR: 500,
};

/**
 * Thrown by any layer (middleware, service, repository) to produce a
 * specific HTTP error response. Caught once, centrally, by the error
 * handler registered in server.ts — route handlers never need their
 * own try/catch for this.
 */
export class HttpError extends Error {
  readonly code: ErrorCode;
  readonly status: number;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.code = code;
    this.status = STATUS_BY_CODE[code];
  }
}
