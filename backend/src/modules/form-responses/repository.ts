import type { PoolClient } from "pg";
import { getPool } from "../../db/pool.js";

export interface FormResponseRow {
  response_id: string;
  form_version_id: string;
  case_id: string;
  stakeholder_id: string | null;
  submitted_identity: string | null;
  source_grant_id: string | null;
  submitted_at: string;
  review_status: string;
  reviewed_at: string | null;
}

export async function findResponsesByCaseId(
  caseId: string,
  statusFilter: string | null,
): Promise<FormResponseRow[]> {
  const values: unknown[] = [caseId];
  let whereClause = "WHERE case_id = $1";
  if (statusFilter) {
    values.push(statusFilter);
    whereClause += ` AND review_status = $${values.length}`;
  }
  const { rows } = await getPool().query<FormResponseRow>(
    `SELECT response_id, form_version_id, case_id, stakeholder_id, submitted_identity,
            source_grant_id, submitted_at, review_status, reviewed_at
     FROM form_responses
     ${whereClause}
     ORDER BY submitted_at ASC`,
    values,
  );
  return rows;
}

export async function findResponseById(responseId: string): Promise<FormResponseRow | null> {
  const { rows } = await getPool().query<FormResponseRow>(
    `SELECT response_id, form_version_id, case_id, stakeholder_id, submitted_identity,
            source_grant_id, submitted_at, review_status, reviewed_at
     FROM form_responses
     WHERE response_id = $1`,
    [responseId],
  );
  return rows[0] ?? null;
}

export interface FormAnswerRow {
  form_answer_id: string;
  response_id: string;
  form_version_id: string;
  form_item_id: string;
  answer_value: unknown;
  answer_status: string;
  answered_at: string;
  review_note: string | null;
}

export async function findAnswersByResponseId(responseId: string): Promise<FormAnswerRow[]> {
  const { rows } = await getPool().query<FormAnswerRow>(
    `SELECT form_answer_id, response_id, form_version_id, form_item_id, answer_value,
            answer_status, answered_at, review_note
     FROM form_answers
     WHERE response_id = $1`,
    [responseId],
  );
  return rows;
}

/**
 * form_responses has no reviewed_by column in the applied (repaired)
 * schema - verified directly against
 * 20261022071002_repair_stakeholder_form_schema.sql, which
 * superseded the original creation migration's version that did have
 * one. "Who reviewed this" is therefore not recorded on the row
 * itself in this slice; only that a review happened (review_status,
 * reviewed_at).
 */
export async function updateResponseReviewStatus(
  client: PoolClient,
  params: { responseId: string; reviewStatus: string },
): Promise<FormResponseRow | null> {
  const { rows } = await client.query<FormResponseRow>(
    `UPDATE form_responses
     SET review_status = $2, reviewed_at = now()
     WHERE response_id = $1
     RETURNING response_id, form_version_id, case_id, stakeholder_id, submitted_identity,
               source_grant_id, submitted_at, review_status, reviewed_at`,
    [params.responseId, params.reviewStatus],
  );
  return rows[0] ?? null;
}
