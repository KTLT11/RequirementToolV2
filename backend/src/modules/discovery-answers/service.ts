// P3-FR-006 / FR-009 — Discovery Answer. Records a BA-entered answer
// to one Discovery Module question, with its own Known/Unknown/
// Assumption/N-A status (answer_status) distinct from Evidence's
// separate Review Status / Evidence Status pair (Evidence lives in
// its own module, not here, and tracks externally-sourced assertions
// -- a Discovery Answer is the BA's own internal record of what they
// found out, which may or may not later become Evidence depending on
// the module-not-yet-implemented in this slice).
//
// question_definition_version_id has no DB-level FK (verified
// against the applied migration), so this service is the only place
// that checks it refers to a real, seeded QUESTION definition in the
// Rule Registry - never a bare "is this a UUID" check, per the
// explicit requirement that Discovery Answer must reference an
// existing Question DefinitionVersion, not just any UUID.
//
// discovery_answers.answer_id DOES carry a FK to entity_identities
// (added by a later repair migration, confirmed the hard way via a
// live 23503 foreign-key violation during integration testing - the
// original table-creation migration alone does not show this). Every
// create therefore registers a new entity first and writes its first
// revision; every update writes the next revision, keeping
// current_revision_no in the row in sync with entity_revisions,
// exactly mirroring the Context/Scope pattern in
// src/modules/entities/repository.ts.

import { HttpError } from "../../http/errors.js";
import { withTransaction } from "../../db/pool.js";
import * as repo from "./repository.js";
import { isActiveQuestionDefinition } from "../definitions/repository.js";
import { registerEntity, createRevision } from "../entities/repository.js";

const ANSWER_STATUSES = ["KNOWN", "UNKNOWN", "ASSUMPTION", "N_A"] as const;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

export async function listAnswersService(caseId: string) {
  if (!isUuid(caseId)) {
    throw new HttpError("VALIDATION_ERROR", "case_id must be a valid UUID");
  }
  const rows = await repo.findAnswersByCaseId(caseId);
  return { data: rows };
}

export interface CreateAnswerInput {
  module_application_id?: unknown;
  question_definition_version_id?: unknown;
  answer_text?: unknown;
  answer_status?: unknown;
  source_entity_id?: unknown;
}

export async function createAnswerService(
  caseId: string,
  body: CreateAnswerInput,
  callerUserId: string,
) {
  if (!isUuid(caseId)) {
    throw new HttpError("VALIDATION_ERROR", "case_id must be a valid UUID");
  }
  if (
    typeof body.question_definition_version_id !== "string" ||
    !isUuid(body.question_definition_version_id)
  ) {
    throw new HttpError(
      "VALIDATION_ERROR",
      "question_definition_version_id must be a valid UUID",
    );
  }
  if (
    typeof body.answer_status !== "string" ||
    !ANSWER_STATUSES.includes(body.answer_status as (typeof ANSWER_STATUSES)[number])
  ) {
    throw new HttpError(
      "VALIDATION_ERROR",
      `answer_status must be one of: ${ANSWER_STATUSES.join(", ")}`,
    );
  }

  const isActive = await isActiveQuestionDefinition(body.question_definition_version_id);
  if (!isActive) {
    throw new HttpError(
      "VALIDATION_ERROR",
      "question_definition_version_id does not refer to an active QUESTION definition in the Rule Registry",
    );
  }

  const moduleApplicationId =
    typeof body.module_application_id === "string" && body.module_application_id.trim()
      ? body.module_application_id
      : null;
  if (moduleApplicationId !== null && !isUuid(moduleApplicationId)) {
    throw new HttpError(
      "VALIDATION_ERROR",
      "module_application_id must be a valid UUID when provided",
    );
  }
  const answerText = typeof body.answer_text === "string" ? body.answer_text : null;
  const sourceEntityId =
    typeof body.source_entity_id === "string" && body.source_entity_id.trim()
      ? body.source_entity_id
      : null;
  if (sourceEntityId !== null && !isUuid(sourceEntityId)) {
    throw new HttpError("VALIDATION_ERROR", "source_entity_id must be a valid UUID when provided");
  }

  const result = await withTransaction(async (client) => {
    const answerId = await registerEntity(client, "DISCOVERY_ANSWER");

    const created = await repo.insertAnswer(client, {
      answerId,
      caseId,
      moduleApplicationId,
      questionDefinitionVersionId: body.question_definition_version_id as string,
      answerText,
      answerStatus: body.answer_status as string,
      sourceEntityId,
      recordedBy: callerUserId,
    });

    await createRevision(client, {
      entityId: answerId,
      revisionNo: 1,
      content: { answer_text: created.answer_text, answer_status: created.answer_status },
      createdBy: callerUserId,
      changeSummary: "Discovery answer created",
    });

    return created;
  });

  return { data: result };
}

export interface UpdateAnswerInput {
  answer_text?: unknown;
  answer_status?: unknown;
  source_entity_id?: unknown;
}

export async function updateAnswerService(
  answerId: string,
  body: UpdateAnswerInput,
  callerUserId: string,
) {
  if (!isUuid(answerId)) {
    throw new HttpError("VALIDATION_ERROR", "answer_id must be a valid UUID");
  }
  if (
    typeof body.answer_status !== "string" ||
    !ANSWER_STATUSES.includes(body.answer_status as (typeof ANSWER_STATUSES)[number])
  ) {
    throw new HttpError(
      "VALIDATION_ERROR",
      `answer_status must be one of: ${ANSWER_STATUSES.join(", ")}`,
    );
  }
  const sourceEntityId =
    typeof body.source_entity_id === "string" && body.source_entity_id.trim()
      ? body.source_entity_id
      : null;
  if (sourceEntityId !== null && !isUuid(sourceEntityId)) {
    throw new HttpError("VALIDATION_ERROR", "source_entity_id must be a valid UUID when provided");
  }
  const answerText = typeof body.answer_text === "string" ? body.answer_text : null;

  const existing = await repo.findAnswerById(answerId);
  if (!existing) {
    throw new HttpError("NOT_FOUND", `Discovery answer ${answerId} was not found`);
  }

  const newRevisionNo = existing.current_revision_no + 1;

  const result = await withTransaction(async (client) => {
    const updated = await repo.updateAnswer(client, {
      answerId,
      answerText,
      answerStatus: body.answer_status as string,
      sourceEntityId,
      newRevisionNo,
    });

    if (!updated) {
      throw new HttpError("NOT_FOUND", `Discovery answer ${answerId} was not found`);
    }

    await createRevision(client, {
      entityId: answerId,
      revisionNo: newRevisionNo,
      content: { answer_text: updated.answer_text, answer_status: updated.answer_status },
      createdBy: callerUserId,
      changeSummary: "Discovery answer updated",
    });

    return updated;
  });

  return { data: result };
}
