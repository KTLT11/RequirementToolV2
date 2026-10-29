import type { PoolClient } from "pg";
import { getPool } from "../../db/pool.js";

export interface DiscoveryAnswerRow {
  answer_id: string;
  case_id: string;
  module_application_id: string | null;
  question_definition_version_id: string;
  answer_text: string | null;
  answer_status: string;
  source_entity_id: string | null;
  current_revision_no: number;
  recorded_by: string;
  recorded_at: string;
}

export async function findAnswersByCaseId(caseId: string): Promise<DiscoveryAnswerRow[]> {
  const { rows } = await getPool().query<DiscoveryAnswerRow>(
    `SELECT answer_id, case_id, module_application_id, question_definition_version_id,
            answer_text, answer_status, source_entity_id, current_revision_no,
            recorded_by, recorded_at
     FROM discovery_answers
     WHERE case_id = $1
     ORDER BY recorded_at ASC`,
    [caseId],
  );
  return rows;
}

export async function findAnswerById(answerId: string): Promise<DiscoveryAnswerRow | null> {
  const { rows } = await getPool().query<DiscoveryAnswerRow>(
    `SELECT answer_id, case_id, module_application_id, question_definition_version_id,
            answer_text, answer_status, source_entity_id, current_revision_no,
            recorded_by, recorded_at
     FROM discovery_answers
     WHERE answer_id = $1`,
    [answerId],
  );
  return rows[0] ?? null;
}

export async function insertAnswer(
  client: PoolClient,
  params: {
    answerId: string; // == entity_id, registered by the caller first
    caseId: string;
    moduleApplicationId: string | null;
    questionDefinitionVersionId: string;
    answerText: string | null;
    answerStatus: string;
    sourceEntityId: string | null;
    recordedBy: string;
  },
): Promise<DiscoveryAnswerRow> {
  const { rows } = await client.query<DiscoveryAnswerRow>(
    `INSERT INTO discovery_answers
       (answer_id, case_id, module_application_id, question_definition_version_id,
        answer_text, answer_status, source_entity_id, recorded_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING answer_id, case_id, module_application_id, question_definition_version_id,
               answer_text, answer_status, source_entity_id, current_revision_no,
               recorded_by, recorded_at`,
    [
      params.answerId,
      params.caseId,
      params.moduleApplicationId,
      params.questionDefinitionVersionId,
      params.answerText,
      params.answerStatus,
      params.sourceEntityId,
      params.recordedBy,
    ],
  );
  return rows[0]!;
}

export async function updateAnswer(
  client: PoolClient,
  params: {
    answerId: string;
    answerText: string | null;
    answerStatus: string;
    sourceEntityId: string | null;
    newRevisionNo: number;
  },
): Promise<DiscoveryAnswerRow | null> {
  const { rows } = await client.query<DiscoveryAnswerRow>(
    `UPDATE discovery_answers
     SET answer_text = $2, answer_status = $3, source_entity_id = $4,
         current_revision_no = $5
     WHERE answer_id = $1
     RETURNING answer_id, case_id, module_application_id, question_definition_version_id,
               answer_text, answer_status, source_entity_id, current_revision_no,
               recorded_by, recorded_at`,
    [params.answerId, params.answerText, params.answerStatus, params.sourceEntityId, params.newRevisionNo],
  );
  return rows[0] ?? null;
}
