import { handleCorsPreflight } from "../_shared/cors.ts";
import { jsonResponse, withErrorBoundary } from "../_shared/responses.ts";
import { errorResponseFromAuth, requireBA } from "../_shared/auth.ts";

async function handler(req: Request): Promise<Response> {
  const preflight = handleCorsPreflight(req);
  if (preflight) return preflight;

  const auth = await requireBA(req);

  if (!auth.ok) {
    return errorResponseFromAuth(auth);
  }

  return jsonResponse(
    {
      status: "ok",
      message: "Requirement Tool backend is reachable",
      caller: {
        userId: auth.context.user.id,
        rtRole: auth.context.rtRole,
      },
      timestamp: new Date().toISOString(),
    },
    200,
  );
}

Deno.serve((req: Request) => withErrorBoundary(handler, req));
