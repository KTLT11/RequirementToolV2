import type { PoolClient } from "pg";
import { getPool } from "../../db/pool.js";

export interface EvidenceRow {
  evidence_id: string;
  case_id: string;
  assertion_text: string;
  source_kind: string;
  source_entity_id: string | null;
  external_source_ref: string | null;
  evidence_status: string;
  review_status: string;
  current_revision_no: number;
  created_at: string;
}

export interface EvidenceReviewRecordRow {
  evidence_review_id: string;
  evidence_id: string;
  evidence_revision_id: string;
  reviewer_user_id: string;
  review_outcome: string;
  review_basis: string;
  reviewed_at: string;
}

export interface EvidenceConfirmationRecordRow {
  evidence_confirmation_id: string;
  evidence_id: string;
  evidence_revision_id: string;
  authority_id: string | null;
  confirming_stakeholder_id: string | null;
  confirmation_outcome: string;
  evidence_basis: string;
  authority_snapshot: unknown;
  occurred_at: string;
  recorded_at: string;
  recorded_by: string;
}

export async function findEvidenceByCaseId(caseId: string): Promise<EvidenceRow[]> {
  const { rows } = await getPool().query<EvidenceRow>(
    `SELECT evidence_id, case_id, assertion_text, source_kind, source_entity_id,
            external_source_ref, evidence_status, review_status, current_revision_no,
            created_at
     FROM evidence
     WHERE case_id = $1
     ORDER BY created_at ASC`,
    [caseId],
  );
  return rows;
}

export async function findEvidenceById(evidenceId: string): Promise<EvidenceRow | null> {
  const { rows } = await getPool().query<EvidenceRow>(
    `SELECT evidence_id, case_id, assertion_text, source_kind, source_entity_id,
            external_source_ref, evidence_status, review_status, current_revision_no,
            created_at
     FROM evidence
     WHERE evidence_id = $1`,
    [evidenceId],
  );
  return rows[0] ?? null;
}

export async function insertEvidence(
  client: PoolClient,
  params: {
    evidenceId: string; // == entity_id, registered by the caller first
    caseId: string;
    assertionText: string;
    sourceKind: string;
    sourceEntityId: string | null;
    externalSourceRef: string | null;
  },
): Promise<EvidenceRow> {
  const { rows } = await client.query<EvidenceRow>(
    `INSERT INTO evidence
       (evidence_id, case_id, assertion_text, source_kind, source_entity_id, external_source_ref)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING evidence_id, case_id, assertion_text, source_kind, source_entity_id,
               external_source_ref, evidence_status, review_status, current_revision_no,
               created_at`,
    [
      params.evidenceId,
      params.caseId,
      params.assertionText,
      params.sourceKind,
      params.sourceEntityId,
      params.externalSourceRef,
    ],
  );
  return rows[0]!;
}

export async function updateEvidenceStatus(
  client: PoolClient,
  params: {
    evidenceId: string;
    evidenceStatus: string;
    reviewStatus: string;
    newRevisionNo: number;
  },
): Promise<EvidenceRow | null> {
  const { rows } = await client.query<EvidenceRow>(
    `UPDATE evidence
     SET evidence_status = $2, review_status = $3, current_revision_no = $4
     WHERE evidence_id = $1
     RETURNING evidence_id, case_id, assertion_text, source_kind, source_entity_id,
               external_source_ref, evidence_status, review_status, current_revision_no,
               created_at`,
    [params.evidenceId, params.evidenceStatus, params.reviewStatus, params.newRevisionNo],
  );
  return rows[0] ?? null;
}

export async function insertReviewRecord(
  client: PoolClient,
  params: {
    evidenceId: string;
    evidenceRevisionId: string;
    reviewerUserId: string;
    reviewOutcome: string;
    reviewBasis: string;
  },
): Promise<EvidenceReviewRecordRow> {
  const { rows } = await client.query<EvidenceReviewRecordRow>(
    `INSERT INTO evidence_review_records
       (evidence_id, evidence_revision_id, reviewer_user_id, review_outcome, review_basis, reviewed_at)
     VALUES ($1, $2, $3, $4, $5, now())
     RETURNING evidence_review_id, evidence_id, evidence_revision_id, reviewer_user_id,
               review_outcome, review_basis, reviewed_at`,
    [params.evidenceId, params.evidenceRevisionId, params.reviewerUserId, params.reviewOutcome, params.reviewBasis],
  );
  return rows[0]!;
}

export async function findReviewRecordsByEvidenceId(
  evidenceId: string,
): Promise<EvidenceReviewRecordRow[]> {
  const { rows } = await getPool().query<EvidenceReviewRecordRow>(
    `SELECT evidence_review_id, evidence_id, evidence_revision_id, reviewer_user_id,
            review_outcome, review_basis, reviewed_at
     FROM evidence_review_records
     WHERE evidence_id = $1
     ORDER BY reviewed_at ASC`,
    [evidenceId],
  );
  return rows;
}

export async function insertConfirmationRecord(
  client: PoolClient,
  params: {
    evidenceId: string;
    evidenceRevisionId: string;
    authorityId: string | null;
    confirmingStakeholderId: string | null;
    confirmationOutcome: string;
    evidenceBasis: string;
    authoritySnapshot: unknown;
    occurredAt: string;
    recordedBy: string;
  },
): Promise<EvidenceConfirmationRecordRow> {
  const { rows } = await client.query<EvidenceConfirmationRecordRow>(
    `INSERT INTO evidence_confirmation_records
       (evidence_id, evidence_revision_id, authority_id, confirming_stakeholder_id,
        confirmation_outcome, evidence_basis, authority_snapshot, occurred_at, recorded_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9)
     RETURNING evidence_confirmation_id, evidence_id, evidence_revision_id, authority_id,
               confirming_stakeholder_id, confirmation_outcome, evidence_basis,
               authority_snapshot, occurred_at, recorded_at, recorded_by`,
    [
      params.evidenceId,
      params.evidenceRevisionId,
      params.authorityId,
      params.confirmingStakeholderId,
      params.confirmationOutcome,
      params.evidenceBasis,
      params.authoritySnapshot !== null ? JSON.stringify(params.authoritySnapshot) : null,
      params.occurredAt,
      params.recordedBy,
    ],
  );
  return rows[0]!;
}

export async function findConfirmationRecordsByEvidenceId(
  evidenceId: string,
): Promise<EvidenceConfirmationRecordRow[]> {
  const { rows } = await getPool().query<EvidenceConfirmationRecordRow>(
    `SELECT evidence_confirmation_id, evidence_id, evidence_revision_id, authority_id,
            confirming_stakeholder_id, confirmation_outcome, evidence_basis,
            authority_snapshot, occurred_at, recorded_at, recorded_by
     FROM evidence_confirmation_records
     WHERE evidence_id = $1
     ORDER BY recorded_at ASC`,
    [evidenceId],
  );
  return rows;
}

/**
 * Looks up the current (highest revision_no) entity_revisions row
 * for a given entity - used to resolve the evidence_revision_id a
 * review/confirmation must pin, per the composite FK into
 * entity_revisions(entity_id, entity_revision_id). Never accepts a
 * revision id from the client.
 */
export async function findLatestRevision(
  entityId: string,
): Promise<{ entity_revision_id: string; revision_no: number } | null> {
  const { rows } = await getPool().query<{ entity_revision_id: string; revision_no: number }>(
    `SELECT entity_revision_id, revision_no
     FROM entity_revisions
     WHERE entity_id = $1
     ORDER BY revision_no DESC
     LIMIT 1`,
    [entityId],
  );
  return rows[0] ?? null;
}
