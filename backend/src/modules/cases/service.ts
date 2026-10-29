// Business logic + transaction orchestration for the Case module.
// Replaces what used to be split across the Edge Function handler and
// the rt_create_case_with_request / rt_update_case RPCs - the exact
// same validation rules and the exact same atomicity guarantee
// (Case + Incoming Request + Association + AuditEvent succeed or fail
// together), now expressed as a direct Postgres transaction instead
// of a SECURITY DEFINER PL/pgSQL function, per the approved MVP design
// (Node.js owns authorization and transactions directly).

import { HttpError } from "../../http/errors.js";
import { withTransaction } from "../../db/pool.js";
import * as repo from "./repository.js";

const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 20;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

// A pg unique_violation (23505) means the body's case_code or
// request_code collided with an existing row - the only cause a
// client-supplied code could trigger here, so it's safe to surface
// as CONFLICT without inspecting which constraint fired.
function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: string }).code === "23505"
  );
}

// ---------------------------------------------------------------------
// List Cases
// ---------------------------------------------------------------------

export interface ListCasesQuery {
  page?: string;
  pageSize?: string;
  search?: string;
  status?: string;
}

export async function listCasesService(query: ListCasesQuery) {
  const search = query.search?.trim() ?? "";
  const statusFilter = query.status?.trim() ?? "";

  const page = query.page ? Number(query.page) : 1;
  const pageSize = query.pageSize ? Number(query.pageSize) : DEFAULT_PAGE_SIZE;

  if (!Number.isInteger(page) || page < 1) {
    throw new HttpError("VALIDATION_ERROR", "page must be a positive integer");
  }
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > MAX_PAGE_SIZE) {
    throw new HttpError(
      "VALIDATION_ERROR",
      `pageSize must be between 1 and ${MAX_PAGE_SIZE}`,
    );
  }

  const { rows, totalCount } = await repo.listCases({
    page,
    pageSize,
    search,
    statusFilter,
  });

  return {
    data: rows,
    pagination: {
      page,
      pageSize,
      totalCount,
      totalPages: totalCount ? Math.ceil(totalCount / pageSize) : 0,
    },
  };
}

// ---------------------------------------------------------------------
// Get Case Detail
// ---------------------------------------------------------------------

export async function getCaseService(caseId: string) {
  if (!isUuid(caseId)) {
    throw new HttpError("VALIDATION_ERROR", "case_id must be a valid UUID");
  }

  const caseRow = await repo.findCaseById(caseId);
  if (!caseRow) {
    throw new HttpError("NOT_FOUND", `Case ${caseId} was not found`);
  }

  const linkedRequestIds = await repo.findActiveLinkedRequestIds(caseId);
  const incomingRequests = await repo.findIncomingRequestsByIds(linkedRequestIds);
  const requirements = await repo.findRequirementSummariesByCaseId(caseId);

  return {
    data: {
      ...caseRow,
      incomingRequests,
      requirements,
    },
  };
}

// ---------------------------------------------------------------------
// Create Case
// ---------------------------------------------------------------------

export interface CreateCaseInput {
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

export async function createCaseService(body: CreateCaseInput, callerUserId: string) {
  if (!isNonEmptyString(body.case_code)) {
    throw new HttpError("VALIDATION_ERROR", "case_code is required");
  }
  if (!isNonEmptyString(body.case_name)) {
    throw new HttpError("VALIDATION_ERROR", "case_name is required");
  }

  const ir = body.incoming_request;
  if (!ir || typeof ir !== "object") {
    throw new HttpError(
      "VALIDATION_ERROR",
      "incoming_request is required: Case creation must save the originating request (P3-FR-001)",
    );
  }
  if (!isNonEmptyString(ir.request_code)) {
    throw new HttpError("VALIDATION_ERROR", "incoming_request.request_code is required");
  }
  if (!isNonEmptyString(ir.request_text)) {
    throw new HttpError("VALIDATION_ERROR", "incoming_request.request_text is required");
  }
  if (!isNonEmptyString(ir.source_type)) {
    throw new HttpError("VALIDATION_ERROR", "incoming_request.source_type is required");
  }

  // received_at is always normalized to a real ISO 8601 string before
  // it reaches the database - never the client's raw input - so a
  // loosely-parseable but malformed value cannot reach the database
  // as anything other than an unambiguous instant.
  let receivedAt: string;
  if (ir.received_at === undefined || ir.received_at === null) {
    receivedAt = new Date().toISOString();
  } else if (typeof ir.received_at === "string") {
    const parsedMs = Date.parse(ir.received_at);
    if (isNaN(parsedMs)) {
      throw new HttpError(
        "VALIDATION_ERROR",
        "incoming_request.received_at must be a valid ISO timestamp when provided",
      );
    }
    receivedAt = new Date(parsedMs).toISOString();
  } else {
    throw new HttpError(
      "VALIDATION_ERROR",
      "incoming_request.received_at must be a valid ISO timestamp when provided",
    );
  }

  const sourceReference =
    typeof ir.source_reference === "string" ? ir.source_reference : null;

  try {
    const result = await withTransaction(async (client) => {
      const newCase = await repo.insertCase(client, {
        caseCode: body.case_code as string,
        caseName: body.case_name as string,
        ownerUserId: callerUserId,
      });

      const newRequest = await repo.insertIncomingRequest(client, {
        requestCode: ir.request_code as string,
        requestText: ir.request_text as string,
        sourceType: ir.source_type as string,
        receivedAt,
        recordedBy: callerUserId,
        sourceReference,
      });

      const association = await repo.insertCaseRequestAssociation(client, {
        caseId: newCase.case_id,
        requestId: newRequest.request_id,
        linkedBy: callerUserId,
      });

      await repo.insertAuditEvent(client, {
        caseId: newCase.case_id,
        eventType: "CASE_CREATED",
        actorUserId: callerUserId,
        eventPayload: {
          case_code: newCase.case_code,
          case_name: newCase.case_name,
          request_id: newRequest.request_id,
          request_code: newRequest.request_code,
        },
      });

      return {
        case: newCase,
        incomingRequest: newRequest,
        association,
      };
    });

    return { data: result };
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new HttpError(
        "CONFLICT",
        "case_code or incoming_request.request_code already exists",
      );
    }
    throw err;
  }
}

// ---------------------------------------------------------------------
// Update Case
// ---------------------------------------------------------------------

export interface UpdateCaseInput {
  case_name?: unknown;
}

export async function updateCaseService(
  caseId: string,
  body: UpdateCaseInput,
  callerUserId: string,
) {
  if (!isUuid(caseId)) {
    throw new HttpError("VALIDATION_ERROR", "case_id must be a valid UUID");
  }
  if (!isNonEmptyString(body.case_name)) {
    throw new HttpError("VALIDATION_ERROR", "case_name is required");
  }

  const result = await withTransaction(async (client) => {
    const updatedCase = await repo.updateCaseName(client, {
      caseId,
      caseName: body.case_name as string,
    });

    if (!updatedCase) {
      // NOT_FOUND must also roll back the transaction (nothing to
      // commit here, but consistent with how every other failure in
      // this module behaves) - thrown inside withTransaction, which
      // already rolls back before rethrowing.
      throw new HttpError("NOT_FOUND", `Case ${caseId} was not found`);
    }

    await repo.insertAuditEvent(client, {
      caseId: updatedCase.case_id,
      eventType: "CASE_UPDATED",
      actorUserId: callerUserId,
      eventPayload: { case_name: updatedCase.case_name },
    });

    return updatedCase;
  });

  return { data: result };
}
