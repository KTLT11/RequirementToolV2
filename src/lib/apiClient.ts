// Single fetch wrapper for every backend call. `credentials: "include"`
// is set here, once, so every call site sends the HttpOnly session
// cookie automatically - no call site constructs its own fetch
// options or risks forgetting this.

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:3000";

export type ErrorCode =
  | "VALIDATION_ERROR"
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "INTERNAL_ERROR";

/**
 * Mirrors the backend's { error: { code, message } } envelope.
 * Thrown by apiRequest on any non-2xx response, so callers can
 * branch on `err.code` (e.g. show "that code is already in use" for
 * CONFLICT, vs a generic message for everything else) instead of
 * inspecting raw HTTP status.
 */
export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly status: number;

  constructor(code: ErrorCode, message: string, status: number) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export async function apiRequest<T>(
  method: "GET" | "POST" | "PATCH",
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`${API_BASE_URL}${path}`, {
    method,
    credentials: "include",
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  const json = text ? JSON.parse(text) : null;

  if (!res.ok) {
    const code: ErrorCode = json?.error?.code ?? "INTERNAL_ERROR";
    const message: string = json?.error?.message ?? "Request failed";
    throw new ApiError(code, message, res.status);
  }

  return json?.data as T;
}
