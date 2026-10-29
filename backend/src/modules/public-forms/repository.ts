import type { PoolClient } from "pg";
import { getPool } from "../../db/pool.js";

export interface PublicFormVersionView {
  form_version_id: string;
  publication_status: string;
  questions: {
    form_item_id: string;
    item_key: string;
    prompt_label: string;
    answer_type: string;
    required_flag: boolean;
    options_json: unknown;
    sort_order: number;
  }[];
}

/**
 * Returns exactly what a stakeholder is allowed to see for a given
 * form version: the question structure only - never the owning
 * form's name/purpose, never the Case it belongs to, never any
 * internal field (per FR-012 AC-04 "Link does not allow reading
 * internal Case information beyond the form content").
 */
export async function findPublicFormView(formVersionId: string): Promise<PublicFormVersionView | null> {
  const { rows: versionRows } = await getPool().query<{
    form_version_id: string;
    publication_status: string;
  }>(
    `SELECT form_version_id, publication_status FROM form_versions WHERE form_version_id = $1`,
    [formVersionId],
  );
  const version = versionRows[0];
  if (!version) return null;

  const { rows: questionRows } = await getPool().query<{
    form_item_id: string;
    item_key: string;
    prompt_label: string;
    answer_type: string;
    required_flag: boolean;
    options_json: unknown;
    sort_order: number;
  }>(
    `SELECT form_item_id, item_key, prompt_label, answer_type, required_flag,
            options_json, sort_order
     FROM form_question_items
     WHERE form_version_id = $1
     ORDER BY sort_order ASC`,
    [formVersionId],
  );

  return { ...version, questions: questionRows };
}

export interface FormResponseInsertParams {
  formVersionId: string;
  caseId: string;
  stakeholderId: string | null;
  submittedIdentity: string | null;
  sourceGrantId: string | null;
}

export async function insertFormResponse(
  client: PoolClient,
  params: FormResponseInsertParams,
): Promise<{ response_id: string; form_version_id: string; case_id: string; review_status: string }> {
  const { rows } = await client.query(
    `INSERT INTO form_responses
       (form_version_id, case_id, stakeholder_id, submitted_identity, source_grant_id, submitted_at)
     VALUES ($1, $2, $3, $4, $5, now())
     RETURNING response_id, form_version_id, case_id, review_status`,
    [
      params.formVersionId,
      params.caseId,
      params.stakeholderId,
      params.submittedIdentity,
      params.sourceGrantId,
    ],
  );
  return rows[0]!;
}

export async function insertFormAnswer(
  client: PoolClient,
  params: {
    responseId: string;
    formVersionId: string;
    formItemId: string;
    answerValue: unknown;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO form_answers (response_id, form_version_id, form_item_id, answer_value, answered_at)
     VALUES ($1, $2, $3, $4::jsonb, now())`,
    [params.responseId, params.formVersionId, params.formItemId, JSON.stringify(params.answerValue)],
  );
}

export async function incrementGrantSubmissions(client: PoolClient, grantId: string): Promise<void> {
  // public_access_grants has no submissions_used column in the
  // applied (repaired) schema (verified - that column only exists in
  // the superseded original creation migration), so there is nothing
  // to increment here. This function is intentionally a no-op kept
  // as a named call site rather than removed, so the "submission was
  // recorded against this grant" step in the flow stays visible in
  // code even though the current schema has no counter to update -
  // if a future migration adds one, only this function changes.
  void client;
  void grantId;
}
