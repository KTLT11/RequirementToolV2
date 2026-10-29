import type { PoolClient } from "pg";
import { getPool } from "../../db/pool.js";

export interface AssessmentRecordRow {
  assessment_id: string;
  case_id: string;
  assessment_type: string;
  manifest_id: string;
  policy_version_id: string;
  validation_run_id: string | null;
  outcome: string;
  summary: string | null;
  result_details: unknown;
  record_status: string;
  assessed_at: string;
  assessed_by: string;
}

export async function findAssessmentsByCaseId(
  caseId: string,
  assessmentType: string | null,
): Promise<AssessmentRecordRow[]> {
  const values: unknown[] = [caseId];
  let whereClause = "WHERE case_id = $1";
  if (assessmentType) {
    values.push(assessmentType);
    whereClause += ` AND assessment_type = $${values.length}`;
  }

  const { rows } = await getPool().query<AssessmentRecordRow>(
    `SELECT assessment_id, case_id, assessment_type, manifest_id, policy_version_id,
            validation_run_id, outcome, summary, result_details, record_status,
            assessed_at, assessed_by
     FROM assessment_records
     ${whereClause}
     ORDER BY assessed_at DESC`,
    values,
  );
  return rows;
}

export async function findAssessmentById(assessmentId: string): Promise<AssessmentRecordRow | null> {
  const { rows } = await getPool().query<AssessmentRecordRow>(
    `SELECT assessment_id, case_id, assessment_type, manifest_id, policy_version_id,
            validation_run_id, outcome, summary, result_details, record_status,
            assessed_at, assessed_by
     FROM assessment_records
     WHERE assessment_id = $1`,
    [assessmentId],
  );
  return rows[0] ?? null;
}

/**
 * Finds the latest FINALIZED assessment of a given type for a Case -
 * used by Readiness Assessment to read the latest finalized QUALITY
 * outcome it depends on (4.1 Dev Readiness Checklist's own precondition
 * "Requirement đã đạt Quality Ready"), and could be reused by any
 * future caller needing "the current finalized X assessment" without
 * re-querying DRAFT (in-progress, not yet authoritative) rows.
 */
export async function findLatestFinalizedAssessment(
  caseId: string,
  assessmentType: string,
): Promise<AssessmentRecordRow | null> {
  const { rows } = await getPool().query<AssessmentRecordRow>(
    `SELECT assessment_id, case_id, assessment_type, manifest_id, policy_version_id,
            validation_run_id, outcome, summary, result_details, record_status,
            assessed_at, assessed_by
     FROM assessment_records
     WHERE case_id = $1 AND assessment_type = $2 AND record_status = 'FINALIZED'
     ORDER BY assessed_at DESC
     LIMIT 1`,
    [caseId, assessmentType],
  );
  return rows[0] ?? null;
}

/**
 * Creates a DRAFT assessment_records row. manifest_id MUST already
 * belong to a FROZEN manifest of the same case_id when this is later
 * finalized - rt_assessment_manifest_case enforces case_id match on
 * INSERT already, and rt_protect_final_assessment enforces the FROZEN
 * check only at the moment record_status transitions to FINALIZED.
 * Callers therefore create this DRAFT referencing a manifest that is
 * either already FROZEN (reusing a prior Validation Run's manifest) or
 * about to be frozen in the same transaction as the run that produces
 * it - never a manifest that will remain DRAFT forever, or finalizing
 * will fail loud via the trigger.
 */
export async function insertDraftAssessment(
  client: PoolClient,
  params: {
    caseId: string;
    assessmentType: string;
    manifestId: string;
    policyVersionId: string;
    validationRunId: string | null;
    outcome: string;
    summary: string | null;
    resultDetails: unknown;
    assessedBy: string;
  },
): Promise<AssessmentRecordRow> {
  const { rows } = await client.query<AssessmentRecordRow>(
    `INSERT INTO assessment_records
       (case_id, assessment_type, manifest_id, policy_version_id, validation_run_id,
        outcome, summary, result_details, record_status, assessed_at, assessed_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, 'DRAFT', now(), $9)
     RETURNING assessment_id, case_id, assessment_type, manifest_id, policy_version_id,
               validation_run_id, outcome, summary, result_details, record_status,
               assessed_at, assessed_by`,
    [
      params.caseId,
      params.assessmentType,
      params.manifestId,
      params.policyVersionId,
      params.validationRunId,
      params.outcome,
      params.summary,
      JSON.stringify(params.resultDetails ?? null),
      params.assessedBy,
    ],
  );
  return rows[0]!;
}

/**
 * The single UPDATE that finalizes a DRAFT assessment - must be the
 * last write against this row (rt_protect_final_assessment rejects any
 * further UPDATE/DELETE once record_status = 'FINALIZED', and requires
 * the referenced manifest to already be FROZEN for the same case_id at
 * this exact moment, not merely when the DRAFT was first inserted).
 */
export async function finalizeAssessment(
  client: PoolClient,
  params: { assessmentId: string },
): Promise<AssessmentRecordRow | null> {
  const { rows } = await client.query<AssessmentRecordRow>(
    `UPDATE assessment_records
     SET record_status = 'FINALIZED'
     WHERE assessment_id = $1
     RETURNING assessment_id, case_id, assessment_type, manifest_id, policy_version_id,
               validation_run_id, outcome, summary, result_details, record_status,
               assessed_at, assessed_by`,
    [params.assessmentId],
  );
  return rows[0] ?? null;
}
