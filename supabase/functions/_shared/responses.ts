import { corsHeaders } from "./cors.ts";

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

export function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
    },
  });
}

export function errorResponse(code: ErrorCode, message: string): Response {
  return jsonResponse(
    {
      error: {
        code,
        message,
      },
    },
    STATUS_BY_CODE[code],
  );
}

/**
 * Runs an Edge Function handler and converts any uncaught exception
 * (config error, network failure, unexpected bug) into a generic 500
 * response. Prevents Deno's default error output - which can include
 * stack traces or internal messages - from ever reaching the client.
 * The real error is logged server-side only, via console.error.
 */
export async function withErrorBoundary(
  handler: (req: Request) => Promise<Response>,
  req: Request,
): Promise<Response> {
  try {
    return await handler(req);
  } catch (err) {
    console.error("Unhandled Edge Function error:", err);
    return errorResponse(
      "INTERNAL_ERROR",
      "An unexpected error occurred. Please try again later.",
    );
  }
}
