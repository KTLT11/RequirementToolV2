// Issue + IssueResolution — Blocker Management (part of Phase 6
// Quality & Completeness Core). issue_id carries a FK to
// entity_identities (confirmed directly against the applied schema -
// see migration 014's comment), so create/update use
// registerEntity()/createRevision() like Requirement/Evidence/Business
// Decision.
//
// issue_type / issue_status / verification_outcome have no DB CHECK
// constraint (free text columns) - the whitelists below are this
// service's own choice, anchored to the Data Dictionary's documented
// vocabulary for these columns, not invented beyond it.

import { HttpError } from "../../http/errors.js";
import { withTransaction } from "../../db/pool.js";
import { registerEntity, createRevision } from "../entities/repository.js";
import * as repo from "./repository.js";

const ISSUE_TYPES = ["GAP", "CONFLICT", "BLOCKER", "QUALITY", "CHANGE_REQUEST"] as const;
const ISSUE_STATUSES = ["OPEN", "IN_CLARIFICATION", "RESOLVED", "REOPENED"] as const;
const VERIFICATION_OUTCOMES = ["PASS", "N_A_WITH_BASIS", "REOPEN_REQUIRED"] as const;

// Only these 2 transitions close an issue (set closed_at) - any other
// transition between the remaining statuses is bookkeeping, not a
// closure event. RESOLVED is the normal closure path; an issue can
// also be closed directly without visiting RESOLVED is NOT allowed -
// this mirrors the Framework's own "resolution requires a verification
// outcome" intent (3.4/4.2), which is enforced by requiring a
// POST .../resolutions call (see resolveIssueService) before an issue
// can move to RESOLVED.
const STATUSES_REQUIRING_RESOLUTION: ReadonlySet<string> = new Set(["RESOLVED"]);

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

export async function listIssuesService(caseId: string, statusFilter?: string) {
  if (!isUuid(caseId)) {
    throw new HttpError("VALIDATION_ERROR", "case_id must be a valid UUID");
  }
  if (statusFilter !== undefined && !ISSUE_STATUSES.includes(statusFilter as (typeof ISSUE_STATUSES)[number])) {
    throw new HttpError("VALIDATION_ERROR", `status must be one of: ${ISSUE_STATUSES.join(", ")}`);
  }
  const rows = await repo.findIssuesByCaseId(caseId, statusFilter ?? null);
  return { data: rows };
}

export async function getIssueService(issueId: string) {
  if (!isUuid(issueId)) {
    throw new HttpError("VALIDATION_ERROR", "issue_id must be a valid UUID");
  }
  const issue = await repo.findIssueById(issueId);
  if (!issue) {
    throw new HttpError("NOT_FOUND", `Issue ${issueId} was not found`);
  }
  const resolutions = await repo.findResolutionsByIssueId(issueId);
  return { data: { ...issue, resolutions } };
}

export interface CreateIssueInput {
  issue_code?: unknown;
  issue_subject?: unknown;
  issue_type?: unknown;
  severity?: unknown;
  assignee_user_id?: unknown;
  source_check_result_id?: unknown;
}

export async function createIssueService(
  caseId: string,
  body: CreateIssueInput,
  callerUserId: string,
) {
  if (!isUuid(caseId)) {
    throw new HttpError("VALIDATION_ERROR", "case_id must be a valid UUID");
  }
  if (!isNonEmptyString(body.issue_code)) {
    throw new HttpError("VALIDATION_ERROR", "issue_code is required");
  }
  if (!isNonEmptyString(body.issue_subject)) {
    throw new HttpError("VALIDATION_ERROR", "issue_subject is required");
  }
  if (
    typeof body.issue_type !== "string" ||
    !ISSUE_TYPES.includes(body.issue_type as (typeof ISSUE_TYPES)[number])
  ) {
    throw new HttpError("VALIDATION_ERROR", `issue_type must be one of: ${ISSUE_TYPES.join(", ")}`);
  }
  const severity = typeof body.severity === "string" && body.severity.trim() ? body.severity : null;
  const assigneeUserId =
    typeof body.assignee_user_id === "string" && body.assignee_user_id.trim()
      ? body.assignee_user_id
      : null;
  if (assigneeUserId !== null && !isUuid(assigneeUserId)) {
    throw new HttpError("VALIDATION_ERROR", "assignee_user_id must be a valid UUID when provided");
  }
  const sourceCheckResultId =
    typeof body.source_check_result_id === "string" && body.source_check_result_id.trim()
      ? body.source_check_result_id
      : null;
  if (sourceCheckResultId !== null && !isUuid(sourceCheckResultId)) {
    throw new HttpError(
      "VALIDATION_ERROR",
      "source_check_result_id must be a valid UUID when provided",
    );
  }

  const exists = await repo.issueCodeExists(caseId, body.issue_code);
  if (exists) {
    throw new HttpError("CONFLICT", "issue_code already exists in this case");
  }

  const result = await withTransaction(async (client) => {
    const issueId = await registerEntity(client, "ISSUE");

    const created = await repo.insertIssue(client, {
      issueId,
      caseId,
      issueCode: body.issue_code as string,
      issueSubject: body.issue_subject as string,
      issueType: body.issue_type as string,
      severity,
      assigneeUserId,
      sourceCheckResultId,
    });

    await createRevision(client, {
      entityId: issueId,
      revisionNo: 1,
      content: {
        issue_subject: created.issue_subject,
        issue_type: created.issue_type,
        issue_status: created.issue_status,
        severity: created.severity,
      },
      createdBy: callerUserId,
      changeSummary: "Issue opened",
    });

    return created;
  });

  return { data: result };
}

export interface UpdateIssueInput {
  issue_subject?: unknown;
  issue_status?: unknown;
  severity?: unknown;
  assignee_user_id?: unknown;
}

export async function updateIssueService(
  issueId: string,
  body: UpdateIssueInput,
  callerUserId: string,
) {
  if (!isUuid(issueId)) {
    throw new HttpError("VALIDATION_ERROR", "issue_id must be a valid UUID");
  }
  if (!isNonEmptyString(body.issue_subject)) {
    throw new HttpError("VALIDATION_ERROR", "issue_subject is required");
  }
  if (
    typeof body.issue_status !== "string" ||
    !ISSUE_STATUSES.includes(body.issue_status as (typeof ISSUE_STATUSES)[number])
  ) {
    throw new HttpError("VALIDATION_ERROR", `issue_status must be one of: ${ISSUE_STATUSES.join(", ")}`);
  }

  const existing = await repo.findIssueById(issueId);
  if (!existing) {
    throw new HttpError("NOT_FOUND", `Issue ${issueId} was not found`);
  }

  if (STATUSES_REQUIRING_RESOLUTION.has(body.issue_status) && existing.issue_status !== "RESOLVED") {
    const resolutions = await repo.findResolutionsByIssueId(issueId);
    if (resolutions.length === 0) {
      throw new HttpError(
        "VALIDATION_ERROR",
        "Moving an issue to RESOLVED requires recording a resolution first via POST /api/issues/:issueId/resolutions",
      );
    }
  }

  const severity = typeof body.severity === "string" && body.severity.trim() ? body.severity : null;
  const assigneeUserId =
    typeof body.assignee_user_id === "string" && body.assignee_user_id.trim()
      ? body.assignee_user_id
      : null;
  if (assigneeUserId !== null && !isUuid(assigneeUserId)) {
    throw new HttpError("VALIDATION_ERROR", "assignee_user_id must be a valid UUID when provided");
  }

  const closedAt = body.issue_status === "RESOLVED" ? new Date().toISOString() : existing.closed_at;
  const newRevisionNo = existing.current_revision_no + 1;

  const result = await withTransaction(async (client) => {
    const updated = await repo.updateIssue(client, {
      issueId,
      issueSubject: body.issue_subject as string,
      issueStatus: body.issue_status as string,
      severity,
      assigneeUserId,
      closedAt,
      newRevisionNo,
    });

    if (!updated) {
      throw new HttpError("NOT_FOUND", `Issue ${issueId} was not found`);
    }

    await createRevision(client, {
      entityId: issueId,
      revisionNo: newRevisionNo,
      content: {
        issue_subject: updated.issue_subject,
        issue_type: updated.issue_type,
        issue_status: updated.issue_status,
        severity: updated.severity,
      },
      createdBy: callerUserId,
      changeSummary: "Issue updated",
    });

    return updated;
  });

  return { data: result };
}

export interface CreateResolutionInput {
  resolution_method?: unknown;
  resolution_summary?: unknown;
  verification_outcome?: unknown;
  verification_result_id?: unknown;
  resolution_evidence_id?: unknown;
  resolution_decision_id?: unknown;
}

/**
 * Records a resolution event for an Issue (3.4/4.2's "resolution
 * method, evidence, and verification outcome" intent) - append-only,
 * never updates the Issue itself. A separate PATCH to issue_status is
 * still required to actually move the Issue to RESOLVED (see
 * updateIssueService's guard) - recording a resolution establishes the
 * evidence/basis for that transition without forcing it to happen in
 * the same call.
 */
export async function resolveIssueService(
  issueId: string,
  body: CreateResolutionInput,
  callerUserId: string,
) {
  if (!isUuid(issueId)) {
    throw new HttpError("VALIDATION_ERROR", "issue_id must be a valid UUID");
  }
  const issue = await repo.findIssueById(issueId);
  if (!issue) {
    throw new HttpError("NOT_FOUND", `Issue ${issueId} was not found`);
  }
  if (!isNonEmptyString(body.resolution_method)) {
    throw new HttpError("VALIDATION_ERROR", "resolution_method is required");
  }
  if (!isNonEmptyString(body.resolution_summary)) {
    throw new HttpError("VALIDATION_ERROR", "resolution_summary is required");
  }
  if (
    typeof body.verification_outcome !== "string" ||
    !VERIFICATION_OUTCOMES.includes(body.verification_outcome as (typeof VERIFICATION_OUTCOMES)[number])
  ) {
    throw new HttpError(
      "VALIDATION_ERROR",
      `verification_outcome must be one of: ${VERIFICATION_OUTCOMES.join(", ")}`,
    );
  }

  const verificationResultId =
    typeof body.verification_result_id === "string" && body.verification_result_id.trim()
      ? body.verification_result_id
      : null;
  if (verificationResultId !== null && !isUuid(verificationResultId)) {
    throw new HttpError(
      "VALIDATION_ERROR",
      "verification_result_id must be a valid UUID when provided",
    );
  }
  const resolutionEvidenceId =
    typeof body.resolution_evidence_id === "string" && body.resolution_evidence_id.trim()
      ? body.resolution_evidence_id
      : null;
  if (resolutionEvidenceId !== null && !isUuid(resolutionEvidenceId)) {
    throw new HttpError(
      "VALIDATION_ERROR",
      "resolution_evidence_id must be a valid UUID when provided",
    );
  }
  const resolutionDecisionId =
    typeof body.resolution_decision_id === "string" && body.resolution_decision_id.trim()
      ? body.resolution_decision_id
      : null;
  if (resolutionDecisionId !== null && !isUuid(resolutionDecisionId)) {
    throw new HttpError(
      "VALIDATION_ERROR",
      "resolution_decision_id must be a valid UUID when provided",
    );
  }

  const result = await withTransaction((client) =>
    repo.insertIssueResolution(client, {
      issueId,
      resolutionMethod: body.resolution_method as string,
      resolutionSummary: body.resolution_summary as string,
      verificationOutcome: body.verification_outcome as string,
      verificationResultId,
      resolutionEvidenceId,
      resolutionDecisionId,
      verifiedAt: new Date().toISOString(),
      verifiedBy: callerUserId,
    }),
  );

  return { data: result };
}
