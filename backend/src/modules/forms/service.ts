// Stakeholder Form + Version + Question Item + Public Access Grant
// (P3-FR-012). No table in this module carries a FK to
// entity_identities (confirmed against the repair migration). The
// publication_status state machine on form_versions follows the
// SRS's own table (section 5.2): Draft -> Publish -> Open; Open ->
// Close -> Closed; Open -> Revoke -> Revoked; terminal states reject
// further publish/close/revoke the same way the DB's own
// chk_form_published CHECK ("Draft, or published_at IS NOT NULL")
// already partially enforces.

import { createHash, randomBytes } from "node:crypto";
import { HttpError } from "../../http/errors.js";
import { withTransaction } from "../../db/pool.js";
import * as repo from "./repository.js";

const ANSWER_TYPES = [
  "TEXT",
  "LONG_TEXT",
  "NUMBER",
  "DATE",
  "SINGLE_CHOICE",
  "MULTIPLE_CHOICE",
  "BOOLEAN",
  "FILE",
] as const;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

export async function listFormsService(caseId: string) {
  if (!isUuid(caseId)) {
    throw new HttpError("VALIDATION_ERROR", "case_id must be a valid UUID");
  }
  const rows = await repo.findFormsByCaseId(caseId);
  return { data: rows };
}

export interface CreateFormInput {
  form_name?: unknown;
  form_purpose?: unknown;
}

export async function createFormService(
  caseId: string,
  body: CreateFormInput,
  callerUserId: string,
) {
  if (!isUuid(caseId)) {
    throw new HttpError("VALIDATION_ERROR", "case_id must be a valid UUID");
  }
  if (!isNonEmptyString(body.form_name)) {
    throw new HttpError("VALIDATION_ERROR", "form_name is required");
  }
  const formPurpose = typeof body.form_purpose === "string" ? body.form_purpose : null;

  const result = await withTransaction((client) =>
    repo.insertForm(client, {
      caseId,
      formName: body.form_name as string,
      formPurpose,
      createdBy: callerUserId,
    }),
  );

  return { data: result };
}

export interface QuestionItemInput {
  item_key?: unknown;
  prompt_label?: unknown;
  answer_type?: unknown;
  required_flag?: unknown;
  options_json?: unknown;
  validation_json?: unknown;
  question_definition_version_id?: unknown;
}

export interface CreateVersionInput {
  questions?: unknown;
}

/**
 * Creates a new DRAFT form_version plus its question items, in one
 * transaction (a version with zero questions is not useful, and the
 * AC-01 state machine requires a version to exist in DRAFT before it
 * can ever be published - there is no separate "add question to an
 * existing draft version" endpoint in this slice, matching the
 * schema's intent that question structure is frozen once published,
 * per FormQuestionItem's Data Dictionary note "frozen with version").
 */
export async function createVersionService(
  formId: string,
  body: CreateVersionInput,
) {
  if (!isUuid(formId)) {
    throw new HttpError("VALIDATION_ERROR", "form_id must be a valid UUID");
  }
  const form = await repo.findFormById(formId);
  if (!form) {
    throw new HttpError("NOT_FOUND", `Form ${formId} was not found`);
  }

  if (!Array.isArray(body.questions) || body.questions.length === 0) {
    throw new HttpError("VALIDATION_ERROR", "questions must be a non-empty array");
  }

  const questions = body.questions as QuestionItemInput[];
  const validated: {
    itemKey: string;
    promptLabel: string;
    answerType: string;
    requiredFlag: boolean;
    optionsJson: unknown;
    validationJson: unknown;
    questionDefinitionVersionId: string | null;
  }[] = [];

  for (let i = 0; i < questions.length; i++) {
    const q = questions[i]!;
    if (!isNonEmptyString(q.item_key)) {
      throw new HttpError("VALIDATION_ERROR", `questions[${i}].item_key is required`);
    }
    if (!isNonEmptyString(q.prompt_label)) {
      throw new HttpError("VALIDATION_ERROR", `questions[${i}].prompt_label is required`);
    }
    if (
      typeof q.answer_type !== "string" ||
      !ANSWER_TYPES.includes(q.answer_type as (typeof ANSWER_TYPES)[number])
    ) {
      throw new HttpError(
        "VALIDATION_ERROR",
        `questions[${i}].answer_type must be one of: ${ANSWER_TYPES.join(", ")}`,
      );
    }
    const questionDefinitionVersionId =
      typeof q.question_definition_version_id === "string" && q.question_definition_version_id.trim()
        ? q.question_definition_version_id
        : null;
    if (questionDefinitionVersionId !== null && !isUuid(questionDefinitionVersionId)) {
      throw new HttpError(
        "VALIDATION_ERROR",
        `questions[${i}].question_definition_version_id must be a valid UUID when provided`,
      );
    }
    validated.push({
      itemKey: q.item_key as string,
      promptLabel: q.prompt_label as string,
      answerType: q.answer_type as string,
      requiredFlag: q.required_flag === true,
      optionsJson: q.options_json ?? null,
      validationJson: q.validation_json ?? null,
      questionDefinitionVersionId,
    });
  }

  const nextVersionNo = (await repo.findMaxVersionNo(formId)) + 1;

  const result = await withTransaction(async (client) => {
    const version = await repo.insertVersion(client, { formId, versionNo: nextVersionNo });

    const items = [];
    for (let i = 0; i < validated.length; i++) {
      const q = validated[i]!;
      const item = await repo.insertQuestionItem(client, {
        formVersionId: version.form_version_id,
        itemKey: q.itemKey,
        promptLabel: q.promptLabel,
        answerType: q.answerType,
        requiredFlag: q.requiredFlag,
        optionsJson: q.optionsJson,
        validationJson: q.validationJson,
        sortOrder: i + 1,
        questionDefinitionVersionId: q.questionDefinitionVersionId,
      });
      items.push(item);
    }

    return { version, questions: items };
  });

  return { data: result };
}

export async function getVersionService(formVersionId: string) {
  if (!isUuid(formVersionId)) {
    throw new HttpError("VALIDATION_ERROR", "form_version_id must be a valid UUID");
  }
  const version = await repo.findVersionById(formVersionId);
  if (!version) {
    throw new HttpError("NOT_FOUND", `Form version ${formVersionId} was not found`);
  }
  const questions = await repo.findQuestionItemsByVersionId(formVersionId);
  return { data: { ...version, questions } };
}

const PUBLICATION_TRANSITIONS: Record<string, string[]> = {
  DRAFT: ["OPEN"],
  OPEN: ["CLOSED", "REVOKED"],
  CLOSED: [],
  REVOKED: [],
};

export interface UpdateVersionStatusInput {
  publication_status?: unknown;
}

export async function updateVersionStatusService(
  formVersionId: string,
  body: UpdateVersionStatusInput,
) {
  if (!isUuid(formVersionId)) {
    throw new HttpError("VALIDATION_ERROR", "form_version_id must be a valid UUID");
  }
  if (
    typeof body.publication_status !== "string" ||
    !Object.keys(PUBLICATION_TRANSITIONS).includes(body.publication_status)
  ) {
    throw new HttpError(
      "VALIDATION_ERROR",
      `publication_status must be one of: ${Object.keys(PUBLICATION_TRANSITIONS).join(", ")}`,
    );
  }

  const existing = await repo.findVersionById(formVersionId);
  if (!existing) {
    throw new HttpError("NOT_FOUND", `Form version ${formVersionId} was not found`);
  }

  const allowedNext = PUBLICATION_TRANSITIONS[existing.publication_status] ?? [];
  if (!allowedNext.includes(body.publication_status)) {
    throw new HttpError(
      "VALIDATION_ERROR",
      `Cannot transition form version from ${existing.publication_status} to ${body.publication_status}`,
    );
  }

  const now = new Date().toISOString();
  let publishedAt: string | null = null;
  let closedAt: string | null = null;
  let contentHash: string | null = null;

  if (body.publication_status === "OPEN") {
    publishedAt = now;
    // content_hash per the schema is "Digest of published question
    // structure" - computed from the frozen question items at the
    // moment of publish, so later re-reading the same version always
    // shows the structure that was actually sent to stakeholders.
    const questions = await repo.findQuestionItemsByVersionId(formVersionId);
    const digestInput = JSON.stringify(
      questions.map((q) => ({
        item_key: q.item_key,
        prompt_label: q.prompt_label,
        answer_type: q.answer_type,
        sort_order: q.sort_order,
      })),
    );
    contentHash = createHash("sha256").update(digestInput).digest("hex");
  } else if (body.publication_status === "CLOSED" || body.publication_status === "REVOKED") {
    closedAt = now;
  }

  const result = await withTransaction((client) =>
    repo.updateVersionPublicationStatus(client, {
      formVersionId,
      publicationStatus: body.publication_status as string,
      publishedAt,
      closedAt,
      contentHash,
    }),
  );

  if (!result) {
    throw new HttpError("NOT_FOUND", `Form version ${formVersionId} was not found`);
  }

  return { data: result };
}

export interface CreateGrantInput {
  stakeholder_id?: unknown;
  expires_at?: unknown;
}

/**
 * Creates a public access grant. The returned plaintext token is
 * shown exactly once in this response - only its SHA-256 hash is
 * persisted (token_hash), matching the Data Dictionary's own note
 * ("Only store keyed hash of external token; not clear token").
 * There is no way to retrieve the plaintext token again after this
 * call returns; losing it means issuing a new grant.
 */
export async function createGrantService(formVersionId: string, body: CreateGrantInput) {
  if (!isUuid(formVersionId)) {
    throw new HttpError("VALIDATION_ERROR", "form_version_id must be a valid UUID");
  }
  const version = await repo.findVersionById(formVersionId);
  if (!version) {
    throw new HttpError("NOT_FOUND", `Form version ${formVersionId} was not found`);
  }
  if (version.publication_status !== "OPEN") {
    throw new HttpError(
      "VALIDATION_ERROR",
      "Access grants can only be created for an OPEN form version",
    );
  }

  const stakeholderId =
    typeof body.stakeholder_id === "string" && body.stakeholder_id.trim()
      ? body.stakeholder_id
      : null;
  if (stakeholderId !== null && !isUuid(stakeholderId)) {
    throw new HttpError("VALIDATION_ERROR", "stakeholder_id must be a valid UUID when provided");
  }

  let expiresAt: string | null = null;
  if (typeof body.expires_at === "string") {
    const parsedMs = Date.parse(body.expires_at);
    if (isNaN(parsedMs)) {
      throw new HttpError("VALIDATION_ERROR", "expires_at must be a valid ISO timestamp when provided");
    }
    expiresAt = new Date(parsedMs).toISOString();
  }

  const token = randomBytes(32).toString("base64url");
  const tokenHash = createHash("sha256").update(token).digest("hex");

  const grant = await withTransaction((client) =>
    repo.insertGrant(client, { formVersionId, stakeholderId, tokenHash, expiresAt }),
  );

  return { data: { ...grant, token } };
}

export async function revokeGrantService(grantId: string) {
  if (!isUuid(grantId)) {
    throw new HttpError("VALIDATION_ERROR", "grant_id must be a valid UUID");
  }
  const existing = await repo.findGrantById(grantId);
  if (!existing) {
    throw new HttpError("NOT_FOUND", `Access grant ${grantId} was not found`);
  }
  if (existing.grant_status === "REVOKED") {
    throw new HttpError("VALIDATION_ERROR", "This access grant is already revoked");
  }

  const result = await withTransaction((client) => repo.revokeGrant(client, grantId));
  if (!result) {
    throw new HttpError("NOT_FOUND", `Access grant ${grantId} was not found`);
  }

  return { data: result };
}
