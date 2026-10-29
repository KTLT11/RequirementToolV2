import type { PoolClient } from "pg";
import { getPool } from "../../db/pool.js";

export interface StakeholderFormRow {
  form_id: string;
  case_id: string;
  form_name: string;
  form_purpose: string | null;
  status: string;
  created_by: string;
  created_at: string;
}

export interface FormVersionRow {
  form_version_id: string;
  form_id: string;
  version_no: number;
  publication_status: string;
  content_hash: string | null;
  published_at: string | null;
  closed_at: string | null;
}

export interface FormQuestionItemRow {
  form_item_id: string;
  form_version_id: string;
  question_definition_version_id: string | null;
  item_key: string;
  prompt_label: string;
  answer_type: string;
  required_flag: boolean;
  options_json: unknown;
  validation_json: unknown;
  sort_order: number;
}

export interface PublicAccessGrantRow {
  grant_id: string;
  form_version_id: string;
  stakeholder_id: string | null;
  token_hash: string;
  grant_scope: string;
  grant_status: string;
  expires_at: string | null;
  revoked_at: string | null;
  created_at: string;
}

export async function findFormsByCaseId(caseId: string): Promise<StakeholderFormRow[]> {
  const { rows } = await getPool().query<StakeholderFormRow>(
    `SELECT form_id, case_id, form_name, form_purpose, status, created_by, created_at
     FROM stakeholder_forms
     WHERE case_id = $1
     ORDER BY created_at ASC`,
    [caseId],
  );
  return rows;
}

export async function findFormById(formId: string): Promise<StakeholderFormRow | null> {
  const { rows } = await getPool().query<StakeholderFormRow>(
    `SELECT form_id, case_id, form_name, form_purpose, status, created_by, created_at
     FROM stakeholder_forms
     WHERE form_id = $1`,
    [formId],
  );
  return rows[0] ?? null;
}

export async function insertForm(
  client: PoolClient,
  params: { caseId: string; formName: string; formPurpose: string | null; createdBy: string },
): Promise<StakeholderFormRow> {
  const { rows } = await client.query<StakeholderFormRow>(
    `INSERT INTO stakeholder_forms (case_id, form_name, form_purpose, created_by)
     VALUES ($1, $2, $3, $4)
     RETURNING form_id, case_id, form_name, form_purpose, status, created_by, created_at`,
    [params.caseId, params.formName, params.formPurpose, params.createdBy],
  );
  return rows[0]!;
}

export async function findVersionsByFormId(formId: string): Promise<FormVersionRow[]> {
  const { rows } = await getPool().query<FormVersionRow>(
    `SELECT form_version_id, form_id, version_no, publication_status, content_hash,
            published_at, closed_at
     FROM form_versions
     WHERE form_id = $1
     ORDER BY version_no ASC`,
    [formId],
  );
  return rows;
}

export async function findVersionById(formVersionId: string): Promise<FormVersionRow | null> {
  const { rows } = await getPool().query<FormVersionRow>(
    `SELECT form_version_id, form_id, version_no, publication_status, content_hash,
            published_at, closed_at
     FROM form_versions
     WHERE form_version_id = $1`,
    [formVersionId],
  );
  return rows[0] ?? null;
}

export async function findMaxVersionNo(formId: string): Promise<number> {
  const { rows } = await getPool().query<{ max: number | null }>(
    `SELECT max(version_no) AS max FROM form_versions WHERE form_id = $1`,
    [formId],
  );
  return rows[0]?.max ?? 0;
}

export async function insertVersion(
  client: PoolClient,
  params: { formId: string; versionNo: number },
): Promise<FormVersionRow> {
  const { rows } = await client.query<FormVersionRow>(
    `INSERT INTO form_versions (form_id, version_no)
     VALUES ($1, $2)
     RETURNING form_version_id, form_id, version_no, publication_status, content_hash,
               published_at, closed_at`,
    [params.formId, params.versionNo],
  );
  return rows[0]!;
}

export async function insertQuestionItem(
  client: PoolClient,
  params: {
    formVersionId: string;
    itemKey: string;
    promptLabel: string;
    answerType: string;
    requiredFlag: boolean;
    optionsJson: unknown;
    validationJson: unknown;
    sortOrder: number;
    questionDefinitionVersionId: string | null;
  },
): Promise<FormQuestionItemRow> {
  const { rows } = await client.query<FormQuestionItemRow>(
    `INSERT INTO form_question_items
       (form_version_id, item_key, prompt_label, answer_type, required_flag,
        options_json, validation_json, sort_order, question_definition_version_id)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9)
     RETURNING form_item_id, form_version_id, question_definition_version_id, item_key,
               prompt_label, answer_type, required_flag, options_json, validation_json,
               sort_order`,
    [
      params.formVersionId,
      params.itemKey,
      params.promptLabel,
      params.answerType,
      params.requiredFlag,
      params.optionsJson !== null ? JSON.stringify(params.optionsJson) : null,
      params.validationJson !== null ? JSON.stringify(params.validationJson) : null,
      params.sortOrder,
      params.questionDefinitionVersionId,
    ],
  );
  return rows[0]!;
}

export async function findQuestionItemsByVersionId(
  formVersionId: string,
): Promise<FormQuestionItemRow[]> {
  const { rows } = await getPool().query<FormQuestionItemRow>(
    `SELECT form_item_id, form_version_id, question_definition_version_id, item_key,
            prompt_label, answer_type, required_flag, options_json, validation_json, sort_order
     FROM form_question_items
     WHERE form_version_id = $1
     ORDER BY sort_order ASC`,
    [formVersionId],
  );
  return rows;
}

export async function updateVersionPublicationStatus(
  client: PoolClient,
  params: {
    formVersionId: string;
    publicationStatus: string;
    publishedAt: string | null;
    closedAt: string | null;
    contentHash: string | null;
  },
): Promise<FormVersionRow | null> {
  const { rows } = await client.query<FormVersionRow>(
    `UPDATE form_versions
     SET publication_status = $2, published_at = COALESCE($3, published_at),
         closed_at = $4, content_hash = COALESCE($5, content_hash)
     WHERE form_version_id = $1
     RETURNING form_version_id, form_id, version_no, publication_status, content_hash,
               published_at, closed_at`,
    [params.formVersionId, params.publicationStatus, params.publishedAt, params.closedAt, params.contentHash],
  );
  return rows[0] ?? null;
}

export async function insertGrant(
  client: PoolClient,
  params: {
    formVersionId: string;
    stakeholderId: string | null;
    tokenHash: string;
    expiresAt: string | null;
  },
): Promise<PublicAccessGrantRow> {
  const { rows } = await client.query<PublicAccessGrantRow>(
    `INSERT INTO public_access_grants (form_version_id, stakeholder_id, token_hash, expires_at)
     VALUES ($1, $2, $3, $4)
     RETURNING grant_id, form_version_id, stakeholder_id, token_hash, grant_scope,
               grant_status, expires_at, revoked_at, created_at`,
    [params.formVersionId, params.stakeholderId, params.tokenHash, params.expiresAt],
  );
  return rows[0]!;
}

export async function findGrantById(grantId: string): Promise<PublicAccessGrantRow | null> {
  const { rows } = await getPool().query<PublicAccessGrantRow>(
    `SELECT grant_id, form_version_id, stakeholder_id, token_hash, grant_scope,
            grant_status, expires_at, revoked_at, created_at
     FROM public_access_grants
     WHERE grant_id = $1`,
    [grantId],
  );
  return rows[0] ?? null;
}

export async function findGrantByTokenHash(tokenHash: string): Promise<PublicAccessGrantRow | null> {
  const { rows } = await getPool().query<PublicAccessGrantRow>(
    `SELECT grant_id, form_version_id, stakeholder_id, token_hash, grant_scope,
            grant_status, expires_at, revoked_at, created_at
     FROM public_access_grants
     WHERE token_hash = $1`,
    [tokenHash],
  );
  return rows[0] ?? null;
}

export async function revokeGrant(
  client: PoolClient,
  grantId: string,
): Promise<PublicAccessGrantRow | null> {
  const { rows } = await client.query<PublicAccessGrantRow>(
    `UPDATE public_access_grants
     SET grant_status = 'REVOKED', revoked_at = now()
     WHERE grant_id = $1
     RETURNING grant_id, form_version_id, stakeholder_id, token_hash, grant_scope,
               grant_status, expires_at, revoked_at, created_at`,
    [grantId],
  );
  return rows[0] ?? null;
}
