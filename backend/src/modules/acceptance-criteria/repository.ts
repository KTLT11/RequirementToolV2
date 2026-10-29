import type { PoolClient } from "pg";
import { getPool } from "../../db/pool.js";

export interface AcceptanceCriterionRow {
  ac_id: string;
  requirement_id: string;
  ac_code: string;
  condition_text: string;
  expected_outcome: string;
  verification_method: string | null;
  status: string;
  current_revision_no: number;
  created_at: string;
}

export async function findAcByRequirementId(
  requirementId: string,
): Promise<AcceptanceCriterionRow[]> {
  const { rows } = await getPool().query<AcceptanceCriterionRow>(
    `SELECT ac_id, requirement_id, ac_code, condition_text, expected_outcome,
            verification_method, status, current_revision_no, created_at
     FROM acceptance_criteria
     WHERE requirement_id = $1
     ORDER BY created_at ASC`,
    [requirementId],
  );
  return rows;
}

export async function findAcById(acId: string): Promise<AcceptanceCriterionRow | null> {
  const { rows } = await getPool().query<AcceptanceCriterionRow>(
    `SELECT ac_id, requirement_id, ac_code, condition_text, expected_outcome,
            verification_method, status, current_revision_no, created_at
     FROM acceptance_criteria
     WHERE ac_id = $1`,
    [acId],
  );
  return rows[0] ?? null;
}

export async function insertAc(
  client: PoolClient,
  params: {
    acId: string; // == entity_id, registered by the caller first
    requirementId: string;
    acCode: string;
    conditionText: string;
    expectedOutcome: string;
    verificationMethod: string | null;
  },
): Promise<AcceptanceCriterionRow> {
  const { rows } = await client.query<AcceptanceCriterionRow>(
    `INSERT INTO acceptance_criteria
       (ac_id, requirement_id, ac_code, condition_text, expected_outcome, verification_method)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING ac_id, requirement_id, ac_code, condition_text, expected_outcome,
               verification_method, status, current_revision_no, created_at`,
    [
      params.acId,
      params.requirementId,
      params.acCode,
      params.conditionText,
      params.expectedOutcome,
      params.verificationMethod,
    ],
  );
  return rows[0]!;
}

export async function updateAc(
  client: PoolClient,
  params: {
    acId: string;
    conditionText: string;
    expectedOutcome: string;
    verificationMethod: string | null;
    status: string;
    newRevisionNo: number;
  },
): Promise<AcceptanceCriterionRow | null> {
  const { rows } = await client.query<AcceptanceCriterionRow>(
    `UPDATE acceptance_criteria
     SET condition_text = $2, expected_outcome = $3, verification_method = $4,
         status = $5, current_revision_no = $6
     WHERE ac_id = $1
     RETURNING ac_id, requirement_id, ac_code, condition_text, expected_outcome,
               verification_method, status, current_revision_no, created_at`,
    [
      params.acId,
      params.conditionText,
      params.expectedOutcome,
      params.verificationMethod,
      params.status,
      params.newRevisionNo,
    ],
  );
  return rows[0] ?? null;
}
