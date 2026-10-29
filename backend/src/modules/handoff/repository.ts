import type { PoolClient } from "pg";
import { getPool } from "../../db/pool.js";

export interface HandoffBaselineRow {
  handoff_id: string;
  case_id: string;
  readiness_assessment_id: string;
  manifest_id: string;
  handoff_purpose: string;
  baseline_status: string;
  issued_at: string;
  issued_by: string;
}

export async function insertHandoffBaseline(
  client: PoolClient,
  params: {
    caseId: string;
    readinessAssessmentId: string;
    manifestId: string;
    handoffPurpose: string;
    issuedBy: string;
  },
): Promise<HandoffBaselineRow> {
  const { rows } = await client.query<HandoffBaselineRow>(
    `INSERT INTO handoff_baselines
       (case_id, readiness_assessment_id, manifest_id, handoff_purpose, baseline_status, issued_at, issued_by)
     VALUES ($1, $2, $3, $4, 'ISSUED', now(), $5)
     RETURNING handoff_id, case_id, readiness_assessment_id, manifest_id, handoff_purpose,
               baseline_status, issued_at, issued_by`,
    [params.caseId, params.readinessAssessmentId, params.manifestId, params.handoffPurpose, params.issuedBy],
  );
  return rows[0]!;
}

export async function findHandoffById(handoffId: string): Promise<HandoffBaselineRow | null> {
  const { rows } = await getPool().query<HandoffBaselineRow>(
    `SELECT handoff_id, case_id, readiness_assessment_id, manifest_id, handoff_purpose,
            baseline_status, issued_at, issued_by
     FROM handoff_baselines
     WHERE handoff_id = $1`,
    [handoffId],
  );
  return rows[0] ?? null;
}

export async function findHandoffsByCaseId(caseId: string): Promise<HandoffBaselineRow[]> {
  const { rows } = await getPool().query<HandoffBaselineRow>(
    `SELECT handoff_id, case_id, readiness_assessment_id, manifest_id, handoff_purpose,
            baseline_status, issued_at, issued_by
     FROM handoff_baselines
     WHERE case_id = $1
     ORDER BY issued_at ASC`,
    [caseId],
  );
  return rows;
}

/**
 * The only mutation rt_guard_handoff allows on an existing row:
 * baseline_status ISSUED -> WITHDRAWN or ISSUED -> SUPERSEDED. Every
 * other column is immutable by trigger.
 */
export async function updateHandoffStatus(
  client: PoolClient,
  params: { handoffId: string; baselineStatus: "WITHDRAWN" | "SUPERSEDED" },
): Promise<HandoffBaselineRow | null> {
  const { rows } = await client.query<HandoffBaselineRow>(
    `UPDATE handoff_baselines SET baseline_status = $2
     WHERE handoff_id = $1
     RETURNING handoff_id, case_id, readiness_assessment_id, manifest_id, handoff_purpose,
               baseline_status, issued_at, issued_by`,
    [params.handoffId, params.baselineStatus],
  );
  return rows[0] ?? null;
}

// --- Service-first validation helpers (mirror rt_guard_handoff's own
// conditions - see migration 018's comment for its exact logic). ---

export interface ReadinessAssessmentForHandoffCheck {
  case_id: string;
  assessment_type: string;
  record_status: string;
  outcome: string;
  manifest_id: string;
  assessed_at: string;
}

export async function findReadinessAssessmentForHandoffCheck(
  assessmentId: string,
): Promise<ReadinessAssessmentForHandoffCheck | null> {
  const { rows } = await getPool().query<ReadinessAssessmentForHandoffCheck>(
    `SELECT case_id, assessment_type, record_status, outcome, manifest_id, assessed_at
     FROM assessment_records
     WHERE assessment_id = $1`,
    [assessmentId],
  );
  return rows[0] ?? null;
}

export interface DevReviewRecordRow {
  dev_review_id: string;
  handoff_id: string;
  reviewer_stakeholder_id: string;
  review_outcome: string;
  review_comments: string | null;
  review_evidence_ref: string | null;
  reviewed_at: string | null;
  recorded_at: string;
  recorded_by: string;
}

/**
 * Creates a Dev Review Record. If review_outcome is 'PENDING',
 * reviewed_at MUST be NULL; for any other outcome, reviewed_at MUST be
 * NOT NULL - dev_review_records_check enforces this at the DB level,
 * so the service always passes a reviewedAt consistent with the
 * outcome it's inserting (see service.ts).
 */
export async function insertDevReview(
  client: PoolClient,
  params: {
    handoffId: string;
    reviewerStakeholderId: string;
    reviewOutcome: string;
    reviewComments: string | null;
    reviewEvidenceRef: string | null;
    reviewedAt: string | null;
    recordedBy: string;
  },
): Promise<DevReviewRecordRow> {
  const { rows } = await client.query<DevReviewRecordRow>(
    `INSERT INTO dev_review_records
       (handoff_id, reviewer_stakeholder_id, review_outcome, review_comments, review_evidence_ref,
        reviewed_at, recorded_at, recorded_by)
     VALUES ($1, $2, $3, $4, $5, $6, now(), $7)
     RETURNING dev_review_id, handoff_id, reviewer_stakeholder_id, review_outcome, review_comments,
               review_evidence_ref, reviewed_at, recorded_at, recorded_by`,
    [
      params.handoffId,
      params.reviewerStakeholderId,
      params.reviewOutcome,
      params.reviewComments,
      params.reviewEvidenceRef,
      params.reviewedAt,
      params.recordedBy,
    ],
  );
  return rows[0]!;
}

export async function findDevReviewById(devReviewId: string): Promise<DevReviewRecordRow | null> {
  const { rows } = await getPool().query<DevReviewRecordRow>(
    `SELECT dev_review_id, handoff_id, reviewer_stakeholder_id, review_outcome, review_comments,
            review_evidence_ref, reviewed_at, recorded_at, recorded_by
     FROM dev_review_records
     WHERE dev_review_id = $1`,
    [devReviewId],
  );
  return rows[0] ?? null;
}

export async function findDevReviewsByHandoffId(handoffId: string): Promise<DevReviewRecordRow[]> {
  const { rows } = await getPool().query<DevReviewRecordRow>(
    `SELECT dev_review_id, handoff_id, reviewer_stakeholder_id, review_outcome, review_comments,
            review_evidence_ref, reviewed_at, recorded_at, recorded_by
     FROM dev_review_records
     WHERE handoff_id = $1
     ORDER BY recorded_at ASC`,
    [handoffId],
  );
  return rows;
}

/**
 * The only mutation rt_guard_dev_review allows: while OLD.review_outcome
 * = 'PENDING', updating review_outcome/review_comments/review_evidence_ref/
 * reviewed_at together - handoff_id/reviewer_stakeholder_id/recorded_at/
 * recorded_by must stay identical (enforced by the trigger, not just by
 * this function choosing not to pass them).
 */
export async function updatePendingDevReview(
  client: PoolClient,
  params: {
    devReviewId: string;
    reviewOutcome: string;
    reviewComments: string | null;
    reviewEvidenceRef: string | null;
    reviewedAt: string;
  },
): Promise<DevReviewRecordRow | null> {
  const { rows } = await client.query<DevReviewRecordRow>(
    `UPDATE dev_review_records
     SET review_outcome = $2, review_comments = $3, review_evidence_ref = $4, reviewed_at = $5
     WHERE dev_review_id = $1
     RETURNING dev_review_id, handoff_id, reviewer_stakeholder_id, review_outcome, review_comments,
               review_evidence_ref, reviewed_at, recorded_at, recorded_by`,
    [params.devReviewId, params.reviewOutcome, params.reviewComments, params.reviewEvidenceRef, params.reviewedAt],
  );
  return rows[0] ?? null;
}

/**
 * Checks that a stakeholder belongs to a given Case - used to pre-
 * validate rt_guard_dev_review's own "reviewer must belong to the
 * handoff Case" condition before insert/update.
 */
export async function isStakeholderInCase(caseId: string, stakeholderId: string): Promise<boolean> {
  const { rows } = await getPool().query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM case_stakeholders WHERE case_id = $1 AND stakeholder_id = $2
     ) AS exists`,
    [caseId, stakeholderId],
  );
  return rows[0]?.exists ?? false;
}
