import type { PoolClient } from "pg";
import { getPool } from "../../db/pool.js";

export interface CustomerConfirmationRow {
  confirmation_id: string;
  publication_id: string;
  snapshot_id: string;
  manifest_id: string;
  signer_stakeholder_id: string;
  signer_authority_id: string | null;
  confirmation_outcome: string;
  confirmation_basis: string;
  comments: string | null;
  occurred_at: string;
  recorded_at: string;
  recorded_by: string;
}

export async function insertCustomerConfirmation(
  client: PoolClient,
  params: {
    publicationId: string;
    snapshotId: string;
    manifestId: string;
    signerStakeholderId: string;
    signerAuthorityId: string;
    confirmationOutcome: string;
    confirmationBasis: string;
    comments: string | null;
    occurredAt: string;
    recordedBy: string;
  },
): Promise<CustomerConfirmationRow> {
  const { rows } = await client.query<CustomerConfirmationRow>(
    `INSERT INTO customer_confirmations
       (publication_id, snapshot_id, manifest_id, signer_stakeholder_id, signer_authority_id,
        confirmation_outcome, confirmation_basis, comments, occurred_at, recorded_at, recorded_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now(), $10)
     RETURNING confirmation_id, publication_id, snapshot_id, manifest_id, signer_stakeholder_id,
               signer_authority_id, confirmation_outcome, confirmation_basis, comments,
               occurred_at, recorded_at, recorded_by`,
    [
      params.publicationId,
      params.snapshotId,
      params.manifestId,
      params.signerStakeholderId,
      params.signerAuthorityId,
      params.confirmationOutcome,
      params.confirmationBasis,
      params.comments,
      params.occurredAt,
      params.recordedBy,
    ],
  );
  return rows[0]!;
}

export async function findConfirmationById(confirmationId: string): Promise<CustomerConfirmationRow | null> {
  const { rows } = await getPool().query<CustomerConfirmationRow>(
    `SELECT confirmation_id, publication_id, snapshot_id, manifest_id, signer_stakeholder_id,
            signer_authority_id, confirmation_outcome, confirmation_basis, comments,
            occurred_at, recorded_at, recorded_by
     FROM customer_confirmations
     WHERE confirmation_id = $1`,
    [confirmationId],
  );
  return rows[0] ?? null;
}

export async function findConfirmationsByPublicationId(
  publicationId: string,
): Promise<CustomerConfirmationRow[]> {
  const { rows } = await getPool().query<CustomerConfirmationRow>(
    `SELECT confirmation_id, publication_id, snapshot_id, manifest_id, signer_stakeholder_id,
            signer_authority_id, confirmation_outcome, confirmation_basis, comments,
            occurred_at, recorded_at, recorded_by
     FROM customer_confirmations
     WHERE publication_id = $1
     ORDER BY recorded_at ASC`,
    [publicationId],
  );
  return rows;
}

export interface ConfirmationScopeItemRow {
  confirmation_scope_item_id: string;
  confirmation_id: string;
  manifest_id: string;
  manifest_item_id: string;
  unit_outcome: string;
  note: string | null;
}

export async function insertConfirmationScopeItem(
  client: PoolClient,
  params: {
    confirmationId: string;
    manifestId: string;
    manifestItemId: string;
    unitOutcome: string;
    note: string | null;
  },
): Promise<ConfirmationScopeItemRow> {
  const { rows } = await client.query<ConfirmationScopeItemRow>(
    `INSERT INTO confirmation_scope_items
       (confirmation_id, manifest_id, manifest_item_id, unit_outcome, note)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING confirmation_scope_item_id, confirmation_id, manifest_id, manifest_item_id,
               unit_outcome, note`,
    [params.confirmationId, params.manifestId, params.manifestItemId, params.unitOutcome, params.note],
  );
  return rows[0]!;
}

export async function findScopeItemsByConfirmationId(
  confirmationId: string,
): Promise<ConfirmationScopeItemRow[]> {
  const { rows } = await getPool().query<ConfirmationScopeItemRow>(
    `SELECT confirmation_scope_item_id, confirmation_id, manifest_id, manifest_item_id,
            unit_outcome, note
     FROM confirmation_scope_items
     WHERE confirmation_id = $1`,
    [confirmationId],
  );
  return rows;
}

// --- Service-first validation helpers (mirror rt_guard_customer_confirmation's
// own conditions, so the API gives a clear VALIDATION_ERROR before the
// trigger would otherwise reject with a generic exception; the trigger
// remains the final, unremoved authority - see migration 018's comment
// for its exact logic). ---

export interface PublicationForConfirmation {
  case_id: string;
  document_type: string;
  publication_purpose: string;
  publication_status: string;
  render_status: string;
  published_at: string;
}

export async function findPublicationForConfirmationCheck(
  publicationId: string,
): Promise<PublicationForConfirmation | null> {
  const { rows } = await getPool().query<PublicationForConfirmation>(
    `SELECT d.case_id, d.document_type, p.publication_purpose, p.publication_status,
            ds.render_status, p.published_at
     FROM document_publications p
     JOIN documents d ON d.document_id = p.document_id
     JOIN document_snapshots ds ON ds.snapshot_id = p.snapshot_id
     WHERE p.publication_id = $1`,
    [publicationId],
  );
  return rows[0] ?? null;
}

export async function isManifestFrozenForCase(manifestId: string, caseId: string): Promise<boolean> {
  const { rows } = await getPool().query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM baseline_manifests
       WHERE manifest_id = $1 AND case_id = $2 AND manifest_status = 'FROZEN'
     ) AS exists`,
    [manifestId, caseId],
  );
  return rows[0]?.exists ?? false;
}

export interface AuthorityForConfirmationCheck {
  case_stakeholder_id: string;
  verification_status: string;
  permitted_action: string;
  valid_from: string;
  valid_to: string | null;
}

export async function findAuthorityForConfirmationCheck(
  authorityId: string,
): Promise<AuthorityForConfirmationCheck | null> {
  const { rows } = await getPool().query<AuthorityForConfirmationCheck>(
    `SELECT case_stakeholder_id, verification_status, permitted_action, valid_from, valid_to
     FROM authority_assignments
     WHERE authority_id = $1`,
    [authorityId],
  );
  return rows[0] ?? null;
}

/**
 * Checks that case_stakeholder_id/stakeholder_id/case_id match AND the
 * stakeholder's membership window (joined_at/ended_at) covers
 * occurredAt - mirrors rt_guard_customer_confirmation's own
 * case_stakeholders check exactly, evaluated at the Customer's actual
 * decision time rather than now().
 */
export async function isStakeholderMemberAtTime(params: {
  caseStakeholderId: string;
  caseId: string;
  stakeholderId: string;
  occurredAt: string;
}): Promise<boolean> {
  const { rows } = await getPool().query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM case_stakeholders
       WHERE case_stakeholder_id = $1
         AND case_id = $2
         AND stakeholder_id = $3
         AND joined_at <= $4
         AND (ended_at IS NULL OR $4 < ended_at)
     ) AS exists`,
    [params.caseStakeholderId, params.caseId, params.stakeholderId, params.occurredAt],
  );
  return rows[0]?.exists ?? false;
}
