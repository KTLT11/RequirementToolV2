// HandoffBaseline + DevReviewRecord (Phase 6 P3 Steps 6-7).
//
// Model: Service-first Validation + Database Integrity Guard, same
// posture as confirmations/service.ts. rt_guard_handoff /
// rt_guard_dev_review remain the final, unremoved authority; this
// service pre-checks their conditions for a clearer error and catches
// SQLSTATE P0001 as a last-resort VALIDATION_ERROR mapping.
//
// Per the explicit instruction: this module does NOT infer handoff
// readiness from a snapshot/manifest merely existing. A
// HandoffBaseline can only be created against a readiness_assessment_
// id that is ALREADY a FINALIZED READINESS assessment with outcome
// READY or READY_BUT_BLOCKED for the SAME Case (exactly what
// rt_guard_handoff enforces) - there is no code path here that
// fabricates or bypasses that assessment. If no such assessment
// exists yet, handoff creation fails with a clear VALIDATION_ERROR
// naming the missing precondition, never a silent default.

import { HttpError } from "../../http/errors.js";
import { withTransaction, getPool } from "../../db/pool.js";
import {
  insertDraftManifest,
  freezeManifest,
  insertPublicationManifestItem,
} from "../validation/repository.js";
import { findPublicationById } from "../documents/repository.js";
import * as repo from "./repository.js";
import { createHash } from "node:crypto";

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function isPostgresRaiseException(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: string }).code === "P0001"
  );
}

const HANDOFF_PURPOSES = ["DEV_IMPLEMENTATION", "DEV_REVIEW"] as const;
const HANDOFF_STATUS_TRANSITIONS: Record<string, string[]> = {
  ISSUED: ["WITHDRAWN", "SUPERSEDED"],
  WITHDRAWN: [],
  SUPERSEDED: [],
};

export interface CreateHandoffInput {
  readiness_assessment_id?: unknown;
  publication_ids?: unknown;
  handoff_purpose?: unknown;
}

/**
 * Creates a Handoff Baseline. Reuses the existing Manifest
 * infrastructure (src/modules/validation/repository.ts) rather than
 * building a new mechanism: the caller selects which already-
 * PUBLISHED publications to bundle (publication_ids), this service
 * verifies each one belongs to the same Case and is actually
 * PUBLISHED, creates a fresh manifest_purpose='HANDOFF' manifest,
 * pins each selected publication_id as a PUBLICATION-kind manifest
 * item (membership_role='HANDOFF_ARTIFACT', matching the Data
 * Dictionary's own note that "bundle manifest includes publication
 * artifacts"), and freezes it - all inside the SAME transaction that
 * then inserts handoff_baselines. No scope beyond the exact
 * publication_ids given is ever added (no "pull in the latest
 * snapshot" behavior), and this manifest creation never implies
 * Handoff readiness by itself - rt_guard_handoff still independently
 * requires readiness_assessment_id to already be a FINALIZED
 * READINESS assessment with outcome READY or READY_BUT_BLOCKED for
 * this same Case, checked before any write below.
 */
export async function createHandoffService(
  caseId: string,
  body: CreateHandoffInput,
  callerUserId: string,
) {
  if (!isUuid(caseId)) {
    throw new HttpError("VALIDATION_ERROR", "case_id must be a valid UUID");
  }
  if (typeof body.readiness_assessment_id !== "string" || !isUuid(body.readiness_assessment_id)) {
    throw new HttpError("VALIDATION_ERROR", "readiness_assessment_id must be a valid UUID");
  }
  if (
    typeof body.handoff_purpose !== "string" ||
    !HANDOFF_PURPOSES.includes(body.handoff_purpose as (typeof HANDOFF_PURPOSES)[number])
  ) {
    throw new HttpError("VALIDATION_ERROR", `handoff_purpose must be one of: ${HANDOFF_PURPOSES.join(", ")}`);
  }
  if (!Array.isArray(body.publication_ids) || body.publication_ids.length === 0) {
    throw new HttpError(
      "VALIDATION_ERROR",
      "publication_ids must be a non-empty array naming the published artifacts this handoff bundles",
    );
  }
  const publicationIds = body.publication_ids as unknown[];
  for (let i = 0; i < publicationIds.length; i++) {
    const id = publicationIds[i];
    if (typeof id !== "string" || !isUuid(id)) {
      throw new HttpError("VALIDATION_ERROR", `publication_ids[${i}] must be a valid UUID`);
    }
  }

  const assessment = await repo.findReadinessAssessmentForHandoffCheck(body.readiness_assessment_id);
  if (!assessment) {
    throw new HttpError("VALIDATION_ERROR", "readiness_assessment_id does not refer to an existing assessment");
  }
  if (
    assessment.case_id !== caseId ||
    assessment.assessment_type !== "READINESS" ||
    assessment.record_status !== "FINALIZED" ||
    !["READY", "READY_BUT_BLOCKED"].includes(assessment.outcome)
  ) {
    throw new HttpError(
      "VALIDATION_ERROR",
      "Handoff requires a FINALIZED READINESS assessment of this Case with outcome READY or READY_BUT_BLOCKED",
    );
  }

  // Resolve and verify provenance BEFORE any write: every selected
  // publication must exist, be PUBLISHED, and belong to a Document of
  // this exact Case - never a different Case's artifact, and never an
  // unpublished/withdrawn one silently accepted as official.
  const publicationCaseIds: string[] = [];
  for (const publicationId of publicationIds as string[]) {
    const publication = await findPublicationById(publicationId);
    if (!publication) {
      throw new HttpError("VALIDATION_ERROR", `publication_ids references ${publicationId}, which does not exist`);
    }
    if (publication.publication_status !== "PUBLISHED") {
      throw new HttpError(
        "VALIDATION_ERROR",
        `publication_ids references ${publicationId}, which is not PUBLISHED (status: ${publication.publication_status})`,
      );
    }
    publicationCaseIds.push(publication.document_id);
  }
  // Verify Case ownership via the documents table (publication rows
  // carry document_id, not case_id directly).
  for (const documentId of publicationCaseIds) {
    const { rows } = await getPool().query<{ case_id: string }>(
      `SELECT case_id FROM documents WHERE document_id = $1`,
      [documentId],
    );
    if (rows[0]?.case_id !== caseId) {
      throw new HttpError(
        "VALIDATION_ERROR",
        "publication_ids must all belong to Documents owned by this Case",
      );
    }
  }

  const nowIso = new Date().toISOString();
  if (nowIso < assessment.assessed_at) {
    // Unreachable in practice (now() is always >= a past assessed_at),
    // kept as a defensive check mirroring the trigger's own ordering
    // rule rather than assuming clock ordering is never violated.
    throw new HttpError("VALIDATION_ERROR", "Handoff cannot precede its readiness assessment");
  }

  try {
    const result = await withTransaction(async (client) => {
      const draft = await insertDraftManifest(client, {
        caseId,
        manifestPurpose: "HANDOFF",
        createdBy: callerUserId,
      });

      let sortOrder = 1;
      for (const publicationId of publicationIds as string[]) {
        await insertPublicationManifestItem(client, {
          manifestId: draft.manifest_id,
          publicationId,
          sortOrder: sortOrder++,
          membershipRole: "HANDOFF_ARTIFACT",
        });
      }

      const sortedIds = [...(publicationIds as string[])].sort();
      const manifestSha256 = createHash("sha256").update(sortedIds.join(",")).digest("hex");
      const frozenManifest = await freezeManifest(client, {
        manifestId: draft.manifest_id,
        manifestSha256,
      });
      if (!frozenManifest) {
        throw new HttpError("INTERNAL_ERROR", "Failed to freeze the handoff bundle manifest");
      }

      const handoff = await repo.insertHandoffBaseline(client, {
        caseId,
        readinessAssessmentId: body.readiness_assessment_id as string,
        manifestId: frozenManifest.manifest_id,
        handoffPurpose: body.handoff_purpose as string,
        issuedBy: callerUserId,
      });

      return { manifest: frozenManifest, handoff };
    });
    return { data: result };
  } catch (err) {
    if (err instanceof HttpError) throw err;
    if (isPostgresRaiseException(err)) {
      throw new HttpError(
        "VALIDATION_ERROR",
        err instanceof Error ? err.message : "Handoff baseline was rejected by database constraints",
      );
    }
    throw err;
  }
}

export async function getHandoffService(handoffId: string) {
  if (!isUuid(handoffId)) {
    throw new HttpError("VALIDATION_ERROR", "handoff_id must be a valid UUID");
  }
  const handoff = await repo.findHandoffById(handoffId);
  if (!handoff) {
    throw new HttpError("NOT_FOUND", `Handoff baseline ${handoffId} was not found`);
  }
  const reviews = await repo.findDevReviewsByHandoffId(handoffId);
  return { data: { ...handoff, reviews } };
}

export async function listHandoffsService(caseId: string) {
  if (!isUuid(caseId)) {
    throw new HttpError("VALIDATION_ERROR", "case_id must be a valid UUID");
  }
  const rows = await repo.findHandoffsByCaseId(caseId);
  return { data: rows };
}

export interface UpdateHandoffStatusInput {
  baseline_status?: unknown;
}

export async function updateHandoffStatusService(handoffId: string, body: UpdateHandoffStatusInput) {
  if (!isUuid(handoffId)) {
    throw new HttpError("VALIDATION_ERROR", "handoff_id must be a valid UUID");
  }
  if (
    typeof body.baseline_status !== "string" ||
    !["WITHDRAWN", "SUPERSEDED"].includes(body.baseline_status)
  ) {
    throw new HttpError("VALIDATION_ERROR", "baseline_status must be one of: WITHDRAWN, SUPERSEDED");
  }

  const existing = await repo.findHandoffById(handoffId);
  if (!existing) {
    throw new HttpError("NOT_FOUND", `Handoff baseline ${handoffId} was not found`);
  }
  const allowedNext = HANDOFF_STATUS_TRANSITIONS[existing.baseline_status] ?? [];
  if (!allowedNext.includes(body.baseline_status)) {
    throw new HttpError(
      "VALIDATION_ERROR",
      `Cannot transition handoff from ${existing.baseline_status} to ${body.baseline_status}`,
    );
  }

  const result = await withTransaction((client) =>
    repo.updateHandoffStatus(client, {
      handoffId,
      baselineStatus: body.baseline_status as "WITHDRAWN" | "SUPERSEDED",
    }),
  );
  if (!result) {
    throw new HttpError("NOT_FOUND", `Handoff baseline ${handoffId} was not found`);
  }
  return { data: result };
}

// --- Dev Review Record ---

const REVIEW_OUTCOMES = ["PENDING", "ACCEPTED", "ACCEPTED_WITH_BLOCKERS", "CHANGES_REQUESTED"] as const;

export interface CreateDevReviewInput {
  reviewer_stakeholder_id?: unknown;
  review_outcome?: unknown;
  review_comments?: unknown;
  review_evidence_ref?: unknown;
  reviewed_at?: unknown;
}

/**
 * Creates a Dev Review Record. dev_review_records_check requires
 * reviewed_at IS NULL iff review_outcome = 'PENDING' - this service
 * enforces the same pairing before insert (never leaves it to the
 * trigger alone to catch a caller's inconsistent input).
 */
export async function createDevReviewService(
  handoffId: string,
  body: CreateDevReviewInput,
  callerUserId: string,
) {
  if (!isUuid(handoffId)) {
    throw new HttpError("VALIDATION_ERROR", "handoff_id must be a valid UUID");
  }
  const handoff = await repo.findHandoffById(handoffId);
  if (!handoff) {
    throw new HttpError("NOT_FOUND", `Handoff baseline ${handoffId} was not found`);
  }
  if (typeof body.reviewer_stakeholder_id !== "string" || !isUuid(body.reviewer_stakeholder_id)) {
    throw new HttpError("VALIDATION_ERROR", "reviewer_stakeholder_id must be a valid UUID");
  }
  if (
    typeof body.review_outcome !== "string" ||
    !REVIEW_OUTCOMES.includes(body.review_outcome as (typeof REVIEW_OUTCOMES)[number])
  ) {
    throw new HttpError("VALIDATION_ERROR", `review_outcome must be one of: ${REVIEW_OUTCOMES.join(", ")}`);
  }

  const inCase = await repo.isStakeholderInCase(handoff.case_id, body.reviewer_stakeholder_id);
  if (!inCase) {
    throw new HttpError(
      "VALIDATION_ERROR",
      "reviewer_stakeholder_id must belong to the handoff's own Case",
    );
  }

  const reviewComments = typeof body.review_comments === "string" ? body.review_comments : null;
  const reviewEvidenceRef = typeof body.review_evidence_ref === "string" ? body.review_evidence_ref : null;

  let reviewedAt: string | null = null;
  if (body.review_outcome !== "PENDING") {
    if (typeof body.reviewed_at === "string") {
      const parsedMs = Date.parse(body.reviewed_at);
      if (isNaN(parsedMs)) {
        throw new HttpError("VALIDATION_ERROR", "reviewed_at must be a valid ISO timestamp when provided");
      }
      reviewedAt = new Date(parsedMs).toISOString();
    } else {
      reviewedAt = new Date().toISOString();
    }
  } else if (body.reviewed_at !== undefined && body.reviewed_at !== null) {
    throw new HttpError("VALIDATION_ERROR", "reviewed_at must not be set when review_outcome is PENDING");
  }

  try {
    const result = await withTransaction((client) =>
      repo.insertDevReview(client, {
        handoffId,
        reviewerStakeholderId: body.reviewer_stakeholder_id as string,
        reviewOutcome: body.review_outcome as string,
        reviewComments,
        reviewEvidenceRef,
        reviewedAt,
        recordedBy: callerUserId,
      }),
    );
    return { data: result };
  } catch (err) {
    if (isPostgresRaiseException(err)) {
      throw new HttpError(
        "VALIDATION_ERROR",
        err instanceof Error ? err.message : "Dev review record was rejected by database constraints",
      );
    }
    throw err;
  }
}

export async function getDevReviewService(devReviewId: string) {
  if (!isUuid(devReviewId)) {
    throw new HttpError("VALIDATION_ERROR", "dev_review_id must be a valid UUID");
  }
  const row = await repo.findDevReviewById(devReviewId);
  if (!row) {
    throw new HttpError("NOT_FOUND", `Dev review record ${devReviewId} was not found`);
  }
  return { data: row };
}

export interface UpdateDevReviewInput {
  review_outcome?: unknown;
  review_comments?: unknown;
  review_evidence_ref?: unknown;
}

/**
 * Updates a PENDING Dev Review Record to a terminal outcome.
 * rt_guard_dev_review rejects this entirely once OLD.review_outcome is
 * no longer PENDING ("Completed Dev review is immutable") - this
 * service pre-checks the same condition.
 */
export async function updateDevReviewService(devReviewId: string, body: UpdateDevReviewInput) {
  if (!isUuid(devReviewId)) {
    throw new HttpError("VALIDATION_ERROR", "dev_review_id must be a valid UUID");
  }
  const existing = await repo.findDevReviewById(devReviewId);
  if (!existing) {
    throw new HttpError("NOT_FOUND", `Dev review record ${devReviewId} was not found`);
  }
  if (existing.review_outcome !== "PENDING") {
    throw new HttpError("VALIDATION_ERROR", "A completed Dev review record is immutable");
  }
  if (
    typeof body.review_outcome !== "string" ||
    body.review_outcome === "PENDING" ||
    !REVIEW_OUTCOMES.includes(body.review_outcome as (typeof REVIEW_OUTCOMES)[number])
  ) {
    throw new HttpError(
      "VALIDATION_ERROR",
      `review_outcome must be one of: ${REVIEW_OUTCOMES.filter((o) => o !== "PENDING").join(", ")}`,
    );
  }

  const reviewComments = typeof body.review_comments === "string" ? body.review_comments : null;
  const reviewEvidenceRef = typeof body.review_evidence_ref === "string" ? body.review_evidence_ref : null;

  try {
    const result = await withTransaction((client) =>
      repo.updatePendingDevReview(client, {
        devReviewId,
        reviewOutcome: body.review_outcome as string,
        reviewComments,
        reviewEvidenceRef,
        reviewedAt: new Date().toISOString(),
      }),
    );
    if (!result) {
      throw new HttpError("NOT_FOUND", `Dev review record ${devReviewId} was not found`);
    }
    return { data: result };
  } catch (err) {
    if (err instanceof HttpError) throw err;
    if (isPostgresRaiseException(err)) {
      throw new HttpError(
        "VALIDATION_ERROR",
        err instanceof Error ? err.message : "Dev review record update was rejected by database constraints",
      );
    }
    throw err;
  }
}
