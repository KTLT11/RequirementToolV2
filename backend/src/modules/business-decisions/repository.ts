import type { PoolClient } from "pg";
import { getPool } from "../../db/pool.js";

export interface BusinessDecisionRow {
  decision_id: string;
  case_id: string;
  decision_subject: string;
  decision_text: string;
  decision_outcome: string;
  authority_id: string | null;
  source_evidence_id: string | null;
  current_revision_no: number;
  effective_from: string | null;
  effective_to: string | null;
  created_at: string;
}

export async function findDecisionsByCaseId(caseId: string): Promise<BusinessDecisionRow[]> {
  const { rows } = await getPool().query<BusinessDecisionRow>(
    `SELECT decision_id, case_id, decision_subject, decision_text, decision_outcome,
            authority_id, source_evidence_id, current_revision_no, effective_from,
            effective_to, created_at
     FROM business_decisions
     WHERE case_id = $1
     ORDER BY created_at ASC`,
    [caseId],
  );
  return rows;
}

export async function findDecisionById(decisionId: string): Promise<BusinessDecisionRow | null> {
  const { rows } = await getPool().query<BusinessDecisionRow>(
    `SELECT decision_id, case_id, decision_subject, decision_text, decision_outcome,
            authority_id, source_evidence_id, current_revision_no, effective_from,
            effective_to, created_at
     FROM business_decisions
     WHERE decision_id = $1`,
    [decisionId],
  );
  return rows[0] ?? null;
}

export async function insertDecision(
  client: PoolClient,
  params: {
    decisionId: string; // == entity_id, registered by the caller first
    caseId: string;
    decisionSubject: string;
    decisionText: string;
    decisionOutcome: string;
    authorityId: string | null;
    sourceEvidenceId: string | null;
    effectiveFrom: string | null;
    effectiveTo: string | null;
  },
): Promise<BusinessDecisionRow> {
  const { rows } = await client.query<BusinessDecisionRow>(
    `INSERT INTO business_decisions
       (decision_id, case_id, decision_subject, decision_text, decision_outcome,
        authority_id, source_evidence_id, effective_from, effective_to)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING decision_id, case_id, decision_subject, decision_text, decision_outcome,
               authority_id, source_evidence_id, current_revision_no, effective_from,
               effective_to, created_at`,
    [
      params.decisionId,
      params.caseId,
      params.decisionSubject,
      params.decisionText,
      params.decisionOutcome,
      params.authorityId,
      params.sourceEvidenceId,
      params.effectiveFrom,
      params.effectiveTo,
    ],
  );
  return rows[0]!;
}

export async function updateDecision(
  client: PoolClient,
  params: {
    decisionId: string;
    decisionText: string;
    decisionOutcome: string;
    newRevisionNo: number;
  },
): Promise<BusinessDecisionRow | null> {
  const { rows } = await client.query<BusinessDecisionRow>(
    `UPDATE business_decisions
     SET decision_text = $2, decision_outcome = $3, current_revision_no = $4
     WHERE decision_id = $1
     RETURNING decision_id, case_id, decision_subject, decision_text, decision_outcome,
               authority_id, source_evidence_id, current_revision_no, effective_from,
               effective_to, created_at`,
    [params.decisionId, params.decisionText, params.decisionOutcome, params.newRevisionNo],
  );
  return rows[0] ?? null;
}
