// Customer Confirmation + ConfirmationScopeItem (Phase 6 P3 Step 5).
//
// Model: Service-first Validation + Database Integrity Guard. The
// service pre-checks every condition rt_guard_customer_confirmation
// enforces (publication type/purpose/status, snapshot/manifest
// frozen, occurred_at ordering, signer authority VERIFIED+CONFIRM
// permission within its valid window AT occurred_at, and that the
// authority's case_stakeholder matches signer_stakeholder_id and was
// a member of the Case at occurred_at) so a caller gets a clear,
// specific VALIDATION_ERROR instead of a generic Postgres exception.
// The trigger itself is never removed or weakened - it remains the
// final authority, and any exception it still raises (a race, or a
// condition this service missed) is caught by SQLSTATE and mapped to
// VALIDATION_ERROR rather than leaking a raw Postgres error.
//
// customer_confirmations/confirmation_scope_items are INSERT-only at
// the database level (rt_guard_customer_confirmation / rt_guard_
// confirmation_scope both reject UPDATE and DELETE outright - "history
// is immutable") - this module never attempts either.

import { HttpError } from "../../http/errors.js";
import { withTransaction, getPool } from "../../db/pool.js";
import * as repo from "./repository.js";

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isPostgresRaiseException(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: string }).code === "P0001"
  );
}

const CONFIRMATION_OUTCOMES = ["CONFIRMED", "PARTIAL", "CHANGES_REQUESTED", "REJECTED"] as const;
const SCOPE_UNIT_OUTCOMES = ["CONFIRMED", "NOT_CONFIRMED", "CHANGES_REQUESTED"] as const;

export interface ScopeItemInput {
  manifest_item_id?: unknown;
  unit_outcome?: unknown;
  note?: unknown;
}

export interface CreateConfirmationInput {
  signer_stakeholder_id?: unknown;
  signer_authority_id?: unknown;
  confirmation_outcome?: unknown;
  confirmation_basis?: unknown;
  comments?: unknown;
  occurred_at?: unknown;
  scope_items?: unknown;
}

/**
 * Records a Customer Confirmation against a specific publication,
 * with per-item scope outcomes (ConfirmationScopeItem) in the same
 * transaction. Per FR-025 AC-02, a PARTIAL outcome must name exactly
 * which items were/weren't confirmed via scope_items - this service
 * requires scope_items whenever confirmation_outcome is PARTIAL, and
 * allows (but does not require) it otherwise, since a full CONFIRMED/
 * REJECTED/CHANGES_REQUESTED outcome may not need a per-item
 * breakdown.
 */
export async function createConfirmationService(
  publicationId: string,
  body: CreateConfirmationInput,
  callerUserId: string,
) {
  if (!isUuid(publicationId)) {
    throw new HttpError("VALIDATION_ERROR", "publication_id must be a valid UUID");
  }

  if (typeof body.signer_stakeholder_id !== "string" || !isUuid(body.signer_stakeholder_id)) {
    throw new HttpError("VALIDATION_ERROR", "signer_stakeholder_id must be a valid UUID");
  }
  // signer_authority_id is nullable in the column definition, but
  // rt_guard_customer_confirmation requires it to be present and valid
  // for every INSERT - so this service also requires it, matching the
  // trigger's real, effective behavior rather than the column's bare
  // nullability.
  if (typeof body.signer_authority_id !== "string" || !isUuid(body.signer_authority_id)) {
    throw new HttpError("VALIDATION_ERROR", "signer_authority_id is required and must be a valid UUID");
  }
  if (
    typeof body.confirmation_outcome !== "string" ||
    !CONFIRMATION_OUTCOMES.includes(body.confirmation_outcome as (typeof CONFIRMATION_OUTCOMES)[number])
  ) {
    throw new HttpError(
      "VALIDATION_ERROR",
      `confirmation_outcome must be one of: ${CONFIRMATION_OUTCOMES.join(", ")}`,
    );
  }
  if (!isNonEmptyString(body.confirmation_basis)) {
    throw new HttpError("VALIDATION_ERROR", "confirmation_basis is required");
  }
  const comments = typeof body.comments === "string" ? body.comments : null;

  let occurredAt: string;
  if (typeof body.occurred_at === "string") {
    const parsedMs = Date.parse(body.occurred_at);
    if (isNaN(parsedMs)) {
      throw new HttpError("VALIDATION_ERROR", "occurred_at must be a valid ISO timestamp when provided");
    }
    occurredAt = new Date(parsedMs).toISOString();
  } else {
    occurredAt = new Date().toISOString();
  }

  if (body.confirmation_outcome === "PARTIAL") {
    if (!Array.isArray(body.scope_items) || body.scope_items.length === 0) {
      throw new HttpError(
        "VALIDATION_ERROR",
        "scope_items is required and must be non-empty when confirmation_outcome is PARTIAL",
      );
    }
  }
  const scopeItems = (Array.isArray(body.scope_items) ? body.scope_items : []) as ScopeItemInput[];
  const validatedScopeItems: { manifestItemId: string; unitOutcome: string; note: string | null }[] = [];
  for (let i = 0; i < scopeItems.length; i++) {
    const item = scopeItems[i]!;
    if (typeof item.manifest_item_id !== "string" || !isUuid(item.manifest_item_id)) {
      throw new HttpError("VALIDATION_ERROR", `scope_items[${i}].manifest_item_id must be a valid UUID`);
    }
    if (
      typeof item.unit_outcome !== "string" ||
      !SCOPE_UNIT_OUTCOMES.includes(item.unit_outcome as (typeof SCOPE_UNIT_OUTCOMES)[number])
    ) {
      throw new HttpError(
        "VALIDATION_ERROR",
        `scope_items[${i}].unit_outcome must be one of: ${SCOPE_UNIT_OUTCOMES.join(", ")}`,
      );
    }
    validatedScopeItems.push({
      manifestItemId: item.manifest_item_id,
      unitOutcome: item.unit_outcome,
      note: typeof item.note === "string" ? item.note : null,
    });
  }

  // --- Service-first validation, mirroring rt_guard_customer_confirmation ---

  const publication = await repo.findPublicationForConfirmationCheck(publicationId);
  if (!publication) {
    throw new HttpError("NOT_FOUND", `Document publication ${publicationId} was not found`);
  }
  if (
    publication.document_type !== "CRD" ||
    publication.publication_purpose !== "CUSTOMER_REVIEW" ||
    publication.publication_status !== "PUBLISHED" ||
    publication.render_status !== "FROZEN"
  ) {
    throw new HttpError(
      "VALIDATION_ERROR",
      "Confirmation requires a published CRD customer-review snapshot (PUBLISHED publication, FROZEN snapshot)",
    );
  }
  if (occurredAt < publication.published_at) {
    throw new HttpError("VALIDATION_ERROR", "occurred_at cannot be before the publication's published_at");
  }

  // Need snapshot_id (from document_publications) and manifest_id
  // (from document_snapshots - manifest_id lives on the snapshot, not
  // the publication) for the insert below; not returned by the join
  // above, which only selects fields needed for the checks.
  const { rows: snapshotRows } = await getPool().query<{ snapshot_id: string; manifest_id: string }>(
    `SELECT p.snapshot_id, ds.manifest_id
     FROM document_publications p
     JOIN document_snapshots ds ON ds.snapshot_id = p.snapshot_id
     WHERE p.publication_id = $1`,
    [publicationId],
  );
  const snapshotRef = snapshotRows[0];
  if (!snapshotRef) {
    throw new HttpError("NOT_FOUND", `Document publication ${publicationId} was not found`);
  }

  const manifestFrozen = await repo.isManifestFrozenForCase(snapshotRef.manifest_id, publication.case_id);
  if (!manifestFrozen) {
    throw new HttpError("VALIDATION_ERROR", "Confirmation requires a frozen manifest of the same Case");
  }

  const authority = await repo.findAuthorityForConfirmationCheck(body.signer_authority_id);
  if (!authority) {
    throw new HttpError("VALIDATION_ERROR", "signer_authority_id does not refer to an existing authority");
  }
  if (
    authority.verification_status !== "VERIFIED" ||
    authority.permitted_action !== "CONFIRM" ||
    occurredAt < authority.valid_from ||
    (authority.valid_to !== null && occurredAt >= authority.valid_to)
  ) {
    throw new HttpError(
      "VALIDATION_ERROR",
      "signer_authority_id does not grant a currently-valid, VERIFIED CONFIRM permission at occurred_at",
    );
  }

  const isMember = await repo.isStakeholderMemberAtTime({
    caseStakeholderId: authority.case_stakeholder_id,
    caseId: publication.case_id,
    stakeholderId: body.signer_stakeholder_id,
    occurredAt,
  });
  if (!isMember) {
    throw new HttpError(
      "VALIDATION_ERROR",
      "signer_authority_id does not belong to signer_stakeholder_id's Case membership at occurred_at",
    );
  }

  try {
    const result = await withTransaction(async (client) => {
      const confirmation = await repo.insertCustomerConfirmation(client, {
        publicationId,
        snapshotId: snapshotRef.snapshot_id,
        manifestId: snapshotRef.manifest_id,
        signerStakeholderId: body.signer_stakeholder_id as string,
        signerAuthorityId: body.signer_authority_id as string,
        confirmationOutcome: body.confirmation_outcome as string,
        confirmationBasis: body.confirmation_basis as string,
        comments,
        occurredAt,
        recordedBy: callerUserId,
      });

      const items = [];
      for (const item of validatedScopeItems) {
        items.push(
          await repo.insertConfirmationScopeItem(client, {
            confirmationId: confirmation.confirmation_id,
            manifestId: snapshotRef.manifest_id,
            manifestItemId: item.manifestItemId,
            unitOutcome: item.unitOutcome,
            note: item.note,
          }),
        );
      }

      return { confirmation, scopeItems: items };
    });

    return { data: result };
  } catch (err) {
    if (isPostgresRaiseException(err)) {
      throw new HttpError(
        "VALIDATION_ERROR",
        err instanceof Error ? err.message : "Customer confirmation was rejected by database constraints",
      );
    }
    throw err;
  }
}

export async function getConfirmationService(confirmationId: string) {
  if (!isUuid(confirmationId)) {
    throw new HttpError("VALIDATION_ERROR", "confirmation_id must be a valid UUID");
  }
  const confirmation = await repo.findConfirmationById(confirmationId);
  if (!confirmation) {
    throw new HttpError("NOT_FOUND", `Customer confirmation ${confirmationId} was not found`);
  }
  const scopeItems = await repo.findScopeItemsByConfirmationId(confirmationId);
  return { data: { ...confirmation, scopeItems } };
}

export async function listConfirmationsByPublicationService(publicationId: string) {
  if (!isUuid(publicationId)) {
    throw new HttpError("VALIDATION_ERROR", "publication_id must be a valid UUID");
  }
  const rows = await repo.findConfirmationsByPublicationId(publicationId);
  return { data: rows };
}
