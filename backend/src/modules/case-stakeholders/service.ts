// Case Stakeholder + Role Assignment + Authority Assignment.
//
// case_stakeholders / role_assignments / authority_assignments carry
// no FK to entity_identities (confirmed against the repair
// migration). No registerEntity()/createRevision() calls.
//
// Adding a Stakeholder to a Case with its first role is one
// transaction (case_stakeholders + role_assignments), mirroring the
// Create Case pattern - a CaseStakeholder with zero roles is a
// state the UI would have no good way to represent, so the two
// inserts are not split across separate endpoints.

import { HttpError } from "../../http/errors.js";
import { withTransaction } from "../../db/pool.js";
import { findStakeholderById } from "../stakeholders/repository.js";
import * as repo from "./repository.js";

// authority_type / permitted_action have no DB CHECK constraint
// (free text). AUTHORITY_TYPES below is this service's own
// whitelist, anchored to the two concrete examples the Data
// Dictionary gives for this column ("BUSINESS_CONFIRM,
// SCOPE_APPROVE, etc.") plus a generic OTHER bucket for anything the
// Dictionary's "etc." implies but doesn't name - not invented beyond
// that.
const AUTHORITY_TYPES = ["BUSINESS_CONFIRM", "SCOPE_APPROVE", "OTHER"] as const;
const VERIFICATION_STATUSES = ["VERIFIED", "UNVERIFIED"] as const;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: string }).code === "23505"
  );
}

export async function listCaseStakeholdersService(caseId: string) {
  if (!isUuid(caseId)) {
    throw new HttpError("VALIDATION_ERROR", "case_id must be a valid UUID");
  }
  const rows = await repo.findCaseStakeholdersByCaseId(caseId);
  return { data: rows };
}

export interface AddCaseStakeholderInput {
  stakeholder_id?: unknown;
  role_code?: unknown;
  notes?: unknown;
}

export async function addCaseStakeholderService(
  caseId: string,
  body: AddCaseStakeholderInput,
  callerUserId: string,
) {
  if (!isUuid(caseId)) {
    throw new HttpError("VALIDATION_ERROR", "case_id must be a valid UUID");
  }
  if (typeof body.stakeholder_id !== "string" || !isUuid(body.stakeholder_id)) {
    throw new HttpError("VALIDATION_ERROR", "stakeholder_id must be a valid UUID");
  }
  if (!isNonEmptyString(body.role_code)) {
    throw new HttpError("VALIDATION_ERROR", "role_code is required");
  }
  const stakeholder = await findStakeholderById(body.stakeholder_id);
  if (!stakeholder) {
    throw new HttpError("NOT_FOUND", `Stakeholder ${body.stakeholder_id} was not found`);
  }
  const notes = typeof body.notes === "string" ? body.notes : null;

  try {
    const result = await withTransaction(async (client) => {
      const caseStakeholder = await repo.insertCaseStakeholder(client, {
        caseId,
        stakeholderId: body.stakeholder_id as string,
        notes,
      });

      const role = await repo.insertRoleAssignment(client, {
        caseStakeholderId: caseStakeholder.case_stakeholder_id,
        roleCode: body.role_code as string,
        assignedBy: callerUserId,
      });

      return { caseStakeholder, role };
    });

    return { data: result };
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new HttpError("CONFLICT", "This stakeholder is already a participant in this case");
    }
    throw err;
  }
}

export interface AddRoleInput {
  role_code?: unknown;
}

export async function addRoleService(
  caseStakeholderId: string,
  body: AddRoleInput,
  callerUserId: string,
) {
  if (!isUuid(caseStakeholderId)) {
    throw new HttpError("VALIDATION_ERROR", "case_stakeholder_id must be a valid UUID");
  }
  const caseStakeholder = await repo.findCaseStakeholderById(caseStakeholderId);
  if (!caseStakeholder) {
    throw new HttpError("NOT_FOUND", `Case stakeholder ${caseStakeholderId} was not found`);
  }
  if (!isNonEmptyString(body.role_code)) {
    throw new HttpError("VALIDATION_ERROR", "role_code is required");
  }

  const result = await withTransaction((client) =>
    repo.insertRoleAssignment(client, {
      caseStakeholderId,
      roleCode: body.role_code as string,
      assignedBy: callerUserId,
    }),
  );

  return { data: result };
}

export interface GrantAuthorityInput {
  role_assignment_id?: unknown;
  authority_type?: unknown;
  permitted_action?: unknown;
  scope_entity_id?: unknown;
  scope_notes?: unknown;
  valid_to?: unknown;
  verification_status?: unknown;
}

export async function grantAuthorityService(
  caseStakeholderId: string,
  body: GrantAuthorityInput,
  callerUserId: string,
) {
  if (!isUuid(caseStakeholderId)) {
    throw new HttpError("VALIDATION_ERROR", "case_stakeholder_id must be a valid UUID");
  }
  const caseStakeholder = await repo.findCaseStakeholderById(caseStakeholderId);
  if (!caseStakeholder) {
    throw new HttpError("NOT_FOUND", `Case stakeholder ${caseStakeholderId} was not found`);
  }
  if (
    typeof body.authority_type !== "string" ||
    !AUTHORITY_TYPES.includes(body.authority_type as (typeof AUTHORITY_TYPES)[number])
  ) {
    throw new HttpError(
      "VALIDATION_ERROR",
      `authority_type must be one of: ${AUTHORITY_TYPES.join(", ")}`,
    );
  }
  if (!isNonEmptyString(body.permitted_action)) {
    throw new HttpError("VALIDATION_ERROR", "permitted_action is required");
  }

  let roleAssignmentId: string | null = null;
  if (body.role_assignment_id !== undefined && body.role_assignment_id !== null) {
    if (typeof body.role_assignment_id !== "string" || !isUuid(body.role_assignment_id)) {
      throw new HttpError("VALIDATION_ERROR", "role_assignment_id must be a valid UUID when provided");
    }
    const role = await repo.findRoleAssignment(body.role_assignment_id, caseStakeholderId);
    if (!role) {
      throw new HttpError(
        "VALIDATION_ERROR",
        "role_assignment_id must belong to this case_stakeholder",
      );
    }
    roleAssignmentId = body.role_assignment_id;
  }

  // scope_entity_id has no DB-level FK (bare uuid column) - validated
  // here only as a well-formed UUID, matching the schema's own lack
  // of a stronger constraint. scope_type is implied by whether this
  // is null (CASE scope) or set (REQUIREMENT/DOCUMENT scope in the
  // original design intent) - not re-derived or enforced here beyond
  // format, since the DB itself enforces nothing further either.
  const scopeEntityId =
    typeof body.scope_entity_id === "string" && body.scope_entity_id.trim()
      ? body.scope_entity_id
      : null;
  if (scopeEntityId !== null && !isUuid(scopeEntityId)) {
    throw new HttpError("VALIDATION_ERROR", "scope_entity_id must be a valid UUID when provided");
  }
  const scopeNotes = typeof body.scope_notes === "string" ? body.scope_notes : null;

  let validTo: string | null = null;
  if (typeof body.valid_to === "string") {
    const parsedMs = Date.parse(body.valid_to);
    if (isNaN(parsedMs)) {
      throw new HttpError("VALIDATION_ERROR", "valid_to must be a valid ISO timestamp when provided");
    }
    validTo = new Date(parsedMs).toISOString();
  }

  const verificationStatus =
    typeof body.verification_status === "string" &&
    VERIFICATION_STATUSES.includes(body.verification_status as (typeof VERIFICATION_STATUSES)[number])
      ? body.verification_status
      : "UNVERIFIED";
  const verifiedBy = verificationStatus === "VERIFIED" ? callerUserId : null;

  const validFrom = new Date().toISOString();

  const result = await withTransaction((client) =>
    repo.insertAuthorityAssignment(client, {
      caseStakeholderId,
      roleAssignmentId,
      authorityType: body.authority_type as string,
      permittedAction: body.permitted_action as string,
      scopeEntityId,
      scopeNotes,
      validFrom,
      validTo,
      verificationStatus: verificationStatus as string,
      verifiedBy,
    }),
  );

  return { data: result };
}
