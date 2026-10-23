import { handleCorsPreflight } from "../_shared/cors.ts";
import {
  errorResponse,
  jsonResponse,
  withErrorBoundary,
} from "../_shared/responses.ts";
import {
  errorResponseFromAuth,
  getBearerToken,
  requireBA,
} from "../_shared/auth.ts";
import { createUserScopedClient } from "../_shared/supabaseClient.ts";

const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 20;

// No table in the Data Dictionary / migrations enumerates valid
// `status` values for public.cases beyond
// CHECK (length(btrim(status)) > 0). Case lifecycle is not yet
// defined, so the status filter is accepted as free-text equality
// against whatever value actually exists in the column, rather than
// validated against an invented whitelist.

interface CaseRow {
  case_id: string;
  case_code: string;
  case_name: string;
  status: string;
  primary_owner_user_id: string;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
}

interface IncomingRequestRow {
  request_id: string;
  request_code: string;
  request_text: string;
  source_type: string;
  received_at: string;
  source_reference: string | null;
  created_at: string;
}

interface RequirementSummaryRow {
  requirement_id: string;
  requirement_code: string;
  requirement_type: string;
  title: string;
  lifecycle_status: string;
  priority: string | null;
  created_at: string;
  updated_at: string;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    .test(value);
}

// ---------------------------------------------------------------------
// List Cases: GET /cases?page=&pageSize=&search=&status=
// ---------------------------------------------------------------------
async function listCases(
  req: Request,
  token: string,
): Promise<Response> {
  const url = new URL(req.url);
  const search = url.searchParams.get("search")?.trim() ?? "";
  const statusFilter = url.searchParams.get("status")?.trim() ?? "";

  const pageParam = url.searchParams.get("page");
  const pageSizeParam = url.searchParams.get("pageSize");

  const page = pageParam ? Number(pageParam) : 1;
  const pageSize = pageSizeParam ? Number(pageSizeParam) : DEFAULT_PAGE_SIZE;

  if (!Number.isInteger(page) || page < 1) {
    return errorResponse("VALIDATION_ERROR", "page must be a positive integer");
  }
  if (
    !Number.isInteger(pageSize) || pageSize < 1 || pageSize > MAX_PAGE_SIZE
  ) {
    return errorResponse(
      "VALIDATION_ERROR",
      `pageSize must be between 1 and ${MAX_PAGE_SIZE}`,
    );
  }

  const client = createUserScopedClient(token);
  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;

  let query = client
    .from("cases")
    .select(
      "case_id, case_code, case_name, status, primary_owner_user_id, created_at, updated_at, closed_at",
      { count: "exact" },
    )
    .order("created_at", { ascending: false })
    .range(from, to);

  if (statusFilter) {
    query = query.eq("status", statusFilter);
  }
  if (search) {
    const escaped = search.replace(/[%_]/g, (c) => `\\${c}`);
    query = query.or(
      `case_code.ilike.%${escaped}%,case_name.ilike.%${escaped}%`,
    );
  }

  const { data, error, count } = await query;

  if (error) {
    throw new Error(`List cases query failed: ${error.message}`);
  }

  return jsonResponse(
    {
      data: data as CaseRow[],
      pagination: {
        page,
        pageSize,
        totalCount: count ?? 0,
        totalPages: count ? Math.ceil(count / pageSize) : 0,
      },
    },
    200,
  );
}

// ---------------------------------------------------------------------
// Get Case Detail: GET /cases/:case_id
//
// Returns the Case plus:
// - incomingRequests: requests linked via case_request_associations
//   where unlinked_at IS NULL (still in effect). A request can be
//   linked to the same Case only once per uq_case_request, so this
//   is never more than one row per association, but a Case can have
//   several distinct linked requests (M:N per Data Dictionary 04).
// - requirements: summary fields only (not full statement/rationale)
//   for all Requirement rows owned by this Case. Detail Requirement
//   retrieval belongs to the Specification module, out of scope here.
// Both lists are returned as [] when empty, never omitted or null.
// ---------------------------------------------------------------------
async function getCase(
  caseId: string,
  token: string,
): Promise<Response> {
  if (!isUuid(caseId)) {
    return errorResponse("VALIDATION_ERROR", "case_id must be a valid UUID");
  }

  const client = createUserScopedClient(token);

  const { data: caseData, error: caseError } = await client
    .from("cases")
    .select(
      "case_id, case_code, case_name, status, primary_owner_user_id, created_at, updated_at, closed_at",
    )
    .eq("case_id", caseId)
    .maybeSingle();

  if (caseError) {
    throw new Error(`Get case query failed: ${caseError.message}`);
  }

  if (!caseData) {
    return errorResponse("NOT_FOUND", `Case ${caseId} was not found`);
  }

  const { data: activeLinks, error: linksError } = await client
    .from("case_request_associations")
    .select("request_id")
    .eq("case_id", caseId)
    .is("unlinked_at", null);

  if (linksError) {
    throw new Error(
      `Get case request links query failed: ${linksError.message}`,
    );
  }

  const linkedRequestIds = (activeLinks ?? []).map((row) => row.request_id);

  let incomingRequests: IncomingRequestRow[] = [];
  if (linkedRequestIds.length > 0) {
    const { data: requestRows, error: requestsError } = await client
      .from("incoming_requests")
      .select(
        "request_id, request_code, request_text, source_type, received_at, source_reference, created_at",
      )
      .in("request_id", linkedRequestIds);

    if (requestsError) {
      throw new Error(
        `Get case incoming requests query failed: ${requestsError.message}`,
      );
    }
    incomingRequests = (requestRows ?? []) as IncomingRequestRow[];
  }

  const { data: requirementRows, error: requirementError } = await client
    .from("requirements")
    .select(
      "requirement_id, requirement_code, requirement_type, title, lifecycle_status, priority, created_at, updated_at",
    )
    .eq("case_id", caseId)
    .order("created_at", { ascending: false });

  if (requirementError) {
    throw new Error(
      `Get case requirements query failed: ${requirementError.message}`,
    );
  }

  return jsonResponse(
    {
      data: {
        ...(caseData as CaseRow),
        incomingRequests,
        requirements: (requirementRows ?? []) as RequirementSummaryRow[],
      },
    },
    200,
  );
}

// ---------------------------------------------------------------------
// Create Case: POST /cases
//
// Per P3-FR-001, creating a Case always saves the originating
// Incoming Request and links it via case_request_associations in the
// same transaction. No default Requirement is created (out of scope
// per explicit instruction). Implemented via RPC rt_create_case_with_request
// - see Task 01-A report for the proposed SQL and its deployment status.
// ---------------------------------------------------------------------

interface CreateCaseRequestBody {
  case_code?: unknown;
  case_name?: unknown;
  incoming_request?: {
    request_code?: unknown;
    request_text?: unknown;
    source_type?: unknown;
    received_at?: unknown;
    source_reference?: unknown;
  };
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

async function createCase(req: Request, token: string): Promise<Response> {
  let body: CreateCaseRequestBody;
  try {
    body = await req.json();
  } catch {
    return errorResponse("VALIDATION_ERROR", "Request body must be valid JSON");
  }

  if (!isNonEmptyString(body.case_code)) {
    return errorResponse("VALIDATION_ERROR", "case_code is required");
  }
  if (!isNonEmptyString(body.case_name)) {
    return errorResponse("VALIDATION_ERROR", "case_name is required");
  }

  const ir = body.incoming_request;
  if (!ir || typeof ir !== "object") {
    return errorResponse(
      "VALIDATION_ERROR",
      "incoming_request is required: Case creation must save the " +
        "originating request (P3-FR-001)",
    );
  }
  if (!isNonEmptyString(ir.request_code)) {
    return errorResponse(
      "VALIDATION_ERROR",
      "incoming_request.request_code is required",
    );
  }
  if (!isNonEmptyString(ir.request_text)) {
    return errorResponse(
      "VALIDATION_ERROR",
      "incoming_request.request_text is required",
    );
  }
  if (!isNonEmptyString(ir.source_type)) {
    return errorResponse(
      "VALIDATION_ERROR",
      "incoming_request.source_type is required",
    );
  }

  // received_at is always normalized to a real ISO 8601 string before
  // being sent to the RPC - never the client's raw input - so a
  // loosely-parseable but malformed value (e.g. "10/23/2026") cannot
  // reach the database as anything other than an unambiguous instant.
  let receivedAt: string;
  if (ir.received_at === undefined || ir.received_at === null) {
    receivedAt = new Date().toISOString();
  } else if (typeof ir.received_at === "string") {
    const parsedMs = Date.parse(ir.received_at);
    if (isNaN(parsedMs)) {
      return errorResponse(
        "VALIDATION_ERROR",
        "incoming_request.received_at must be a valid ISO timestamp when provided",
      );
    }
    receivedAt = new Date(parsedMs).toISOString();
  } else {
    return errorResponse(
      "VALIDATION_ERROR",
      "incoming_request.received_at must be a valid ISO timestamp when provided",
    );
  }

  const sourceReference =
    typeof ir.source_reference === "string" ? ir.source_reference : null;

  const client = createUserScopedClient(token);

  const { data, error } = await client.rpc("rt_create_case_with_request", {
    p_case_code: body.case_code,
    p_case_name: body.case_name,
    p_request_code: ir.request_code,
    p_request_text: ir.request_text,
    p_source_type: ir.source_type,
    p_received_at: receivedAt,
    p_source_reference: sourceReference,
  });

  if (error) {
    // Postgres error codes raised explicitly by the RPC (see proposed
    // SQL): 23505 unique_violation -> CONFLICT, 42501 -> FORBIDDEN.
    if (error.code === "23505") {
      return errorResponse(
        "CONFLICT",
        "case_code or incoming_request.request_code already exists",
      );
    }
    if (error.code === "42501") {
      return errorResponse("FORBIDDEN", "Caller is not authorized to create a Case");
    }
    throw new Error(`Create case RPC failed: ${error.message}`);
  }

  return jsonResponse({ data }, 201);
}

// ---------------------------------------------------------------------
// Update Case: PATCH /cases/:case_id
//
// BLOCKED_BY_DEPLOYMENT: the RPC this calls (rt_update_case) does not
// exist yet on Supabase Cloud - see the proposed SQL in the Task 01-A
// report. The handler code below is complete and will function once
// Machine A deploys it; it is still routed and reachable so the
// VALIDATION_ERROR path works today, but the RPC call itself will
// fail with "function does not exist" until deployment. Do not treat
// a successful response from this endpoint as verified before that.
//
// Scope, as explicitly agreed: only case_name may be changed. status,
// closed_at and primary_owner_user_id are not accepted here - no
// Case lifecycle (open/close) or ownership transfer rule has been
// approved yet.
// ---------------------------------------------------------------------

interface UpdateCaseRequestBody {
  case_name?: unknown;
}

async function updateCase(
  req: Request,
  caseId: string,
  token: string,
): Promise<Response> {
  if (!isUuid(caseId)) {
    return errorResponse("VALIDATION_ERROR", "case_id must be a valid UUID");
  }

  let body: UpdateCaseRequestBody;
  try {
    body = await req.json();
  } catch {
    return errorResponse("VALIDATION_ERROR", "Request body must be valid JSON");
  }

  if (!isNonEmptyString(body.case_name)) {
    return errorResponse("VALIDATION_ERROR", "case_name is required");
  }

  const client = createUserScopedClient(token);

  const { data, error } = await client.rpc("rt_update_case", {
    p_case_id: caseId,
    p_case_name: body.case_name,
  });

  if (error) {
    // Postgres error codes raised explicitly by the RPC (see proposed
    // SQL): P0002 no_data_found -> NOT_FOUND, 42501 -> FORBIDDEN.
    if (error.code === "P0002") {
      return errorResponse("NOT_FOUND", `Case ${caseId} was not found`);
    }
    if (error.code === "42501") {
      return errorResponse("FORBIDDEN", "Caller is not authorized to update this Case");
    }
    throw new Error(`Update case RPC failed: ${error.message}`);
  }

  return jsonResponse({ data }, 200);
}

// ---------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------
async function handler(req: Request): Promise<Response> {
  const preflight = handleCorsPreflight(req);
  if (preflight) return preflight;

  const auth = await requireBA(req);
  if (!auth.ok) {
    return errorResponseFromAuth(auth);
  }

  const token = getBearerToken(req);
  if (!token) {
    // requireBA already guarantees a token was present and valid,
    // this is only a defensive narrowing for TypeScript.
    throw new Error("Unexpected missing bearer token after successful auth");
  }

  const url = new URL(req.url);
  const segments = url.pathname.split("/").filter(Boolean);
  // Expected shapes: ["cases"] or ["cases", "<case_id>"]
  const casesIndex = segments.indexOf("cases");
  const caseId = casesIndex >= 0 ? segments[casesIndex + 1] : undefined;

  if (req.method === "GET" && !caseId) {
    return listCases(req, token);
  }

  if (req.method === "GET" && caseId) {
    return getCase(caseId, token);
  }

  if (req.method === "POST" && !caseId) {
    return createCase(req, token);
  }

  if (req.method === "PATCH" && caseId) {
    return updateCase(req, caseId, token);
  }

  return errorResponse(
    "VALIDATION_ERROR",
    `Unsupported route: ${req.method} ${url.pathname}`,
  );
}

Deno.serve((req: Request) => withErrorBoundary(handler, req));
