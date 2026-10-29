// P3-FR-014 — Evidence lifecycle. evidence.evidence_id carries a FK
// to entity_identities (confirmed via the repair migration), so
// create/update use registerEntity()/createRevision() like Context/
// Scope/Requirement/etc.
//
// evidence_review_records and evidence_confirmation_records do NOT
// carry that FK themselves, but DO carry a composite FK into
// entity_revisions(entity_id, entity_revision_id) - meaning every
// review/confirmation must pin a real, existing revision of that
// specific evidence row. This service always resolves "the current
// revision" via findLatestRevision() and never accepts an
// evidence_revision_id from the client - a stakeholder/BA reviewing
// "the evidence" is always reviewing its latest known state, not an
// arbitrary historical one they could otherwise forge.
//
// Per the Evidence Quality Standard (Requirement_Framework.md
// section 0.6): Reviewed != Confirmed, and Confirmed requires an
// authority basis (FR-014 AC-03) - enforced here by requiring
// confirmEvidenceService to validate authority_id against
// case-stakeholders' isAuthorityCurrentlyValid() before writing a
// CONFIRMED outcome.

import { HttpError } from "../../http/errors.js";
import { withTransaction } from "../../db/pool.js";
import { registerEntity, createRevision } from "../entities/repository.js";
import { isAuthorityCurrentlyValid } from "../case-stakeholders/repository.js";
import * as repo from "./repository.js";

const SOURCE_KINDS = ["FORM", "DOCUMENT", "BA", "STAKEHOLDER", "AI_SUGGESTION"] as const;
// evidence_status / review_status are never accepted directly from
// client input in this slice - they are always derived internally
// (defaulted on create, moved to CONFIRMED by confirmEvidenceService,
// mirrored from review_outcome by reviewEvidenceService) - so there
// is no whitelist constant for them here, only for the outcome enums
// a client actually supplies.
const REVIEW_OUTCOMES = ["REVIEWED", "NEEDS_CLARIFICATION", "CONFLICT"] as const;
const CONFIRMATION_OUTCOMES = ["CONFIRMED", "REJECTED", "REQUIRES_CLARIFICATION"] as const;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

export async function listEvidenceService(caseId: string) {
  if (!isUuid(caseId)) {
    throw new HttpError("VALIDATION_ERROR", "case_id must be a valid UUID");
  }
  const rows = await repo.findEvidenceByCaseId(caseId);
  return { data: rows };
}

export async function getEvidenceService(evidenceId: string) {
  if (!isUuid(evidenceId)) {
    throw new HttpError("VALIDATION_ERROR", "evidence_id must be a valid UUID");
  }
  const evidence = await repo.findEvidenceById(evidenceId);
  if (!evidence) {
    throw new HttpError("NOT_FOUND", `Evidence ${evidenceId} was not found`);
  }
  const reviews = await repo.findReviewRecordsByEvidenceId(evidenceId);
  const confirmations = await repo.findConfirmationRecordsByEvidenceId(evidenceId);
  return { data: { ...evidence, reviews, confirmations } };
}

export interface CreateEvidenceInput {
  assertion_text?: unknown;
  source_kind?: unknown;
  source_entity_id?: unknown;
  external_source_ref?: unknown;
}

export async function createEvidenceService(
  caseId: string,
  body: CreateEvidenceInput,
  callerUserId: string,
) {
  if (!isUuid(caseId)) {
    throw new HttpError("VALIDATION_ERROR", "case_id must be a valid UUID");
  }
  if (!isNonEmptyString(body.assertion_text)) {
    throw new HttpError("VALIDATION_ERROR", "assertion_text is required");
  }
  if (
    typeof body.source_kind !== "string" ||
    !SOURCE_KINDS.includes(body.source_kind as (typeof SOURCE_KINDS)[number])
  ) {
    throw new HttpError("VALIDATION_ERROR", `source_kind must be one of: ${SOURCE_KINDS.join(", ")}`);
  }
  const sourceEntityId =
    typeof body.source_entity_id === "string" && body.source_entity_id.trim()
      ? body.source_entity_id
      : null;
  if (sourceEntityId !== null && !isUuid(sourceEntityId)) {
    throw new HttpError("VALIDATION_ERROR", "source_entity_id must be a valid UUID when provided");
  }
  const externalSourceRef =
    typeof body.external_source_ref === "string" ? body.external_source_ref : null;

  const result = await withTransaction(async (client) => {
    const evidenceId = await registerEntity(client, "EVIDENCE");

    const created = await repo.insertEvidence(client, {
      evidenceId,
      caseId,
      assertionText: body.assertion_text as string,
      sourceKind: body.source_kind as string,
      sourceEntityId,
      externalSourceRef,
    });

    await createRevision(client, {
      entityId: evidenceId,
      revisionNo: 1,
      content: {
        assertion_text: created.assertion_text,
        evidence_status: created.evidence_status,
        review_status: created.review_status,
      },
      createdBy: callerUserId,
      changeSummary: "Evidence created",
    });

    return created;
  });

  return { data: result };
}

export interface CreateReviewInput {
  review_outcome?: unknown;
  review_basis?: unknown;
}

/**
 * Records a review event (FR-013/FR-014). This updates
 * evidence.review_status to match the outcome but deliberately does
 * NOT change evidence_status - "Reviewed" is not "Confirmed" (section
 * 0.6 of the Framework); only confirmEvidenceService can move
 * evidence_status to CONFIRMED.
 */
export async function reviewEvidenceService(
  evidenceId: string,
  body: CreateReviewInput,
  callerUserId: string,
) {
  if (!isUuid(evidenceId)) {
    throw new HttpError("VALIDATION_ERROR", "evidence_id must be a valid UUID");
  }
  const evidence = await repo.findEvidenceById(evidenceId);
  if (!evidence) {
    throw new HttpError("NOT_FOUND", `Evidence ${evidenceId} was not found`);
  }
  if (
    typeof body.review_outcome !== "string" ||
    !REVIEW_OUTCOMES.includes(body.review_outcome as (typeof REVIEW_OUTCOMES)[number])
  ) {
    throw new HttpError(
      "VALIDATION_ERROR",
      `review_outcome must be one of: ${REVIEW_OUTCOMES.join(", ")}`,
    );
  }
  if (!isNonEmptyString(body.review_basis)) {
    throw new HttpError("VALIDATION_ERROR", "review_basis is required");
  }

  const latestRevision = await repo.findLatestRevision(evidenceId);
  if (!latestRevision) {
    // Should be unreachable - every Evidence row has at least
    // revision 1 from createEvidenceService - but fail loud rather
    // than insert a review with a nonexistent revision reference.
    throw new HttpError("INTERNAL_ERROR", "No revision history found for this evidence");
  }

  const newRevisionNo = evidence.current_revision_no + 1;
  // review_outcome maps 1:1 onto review_status by construction
  // (REVIEWED/NEEDS_CLARIFICATION/CONFLICT are exactly the review
  // status vocabulary too) - no translation table needed.
  const reviewStatus = body.review_outcome as string;

  const result = await withTransaction(async (client) => {
    const review = await repo.insertReviewRecord(client, {
      evidenceId,
      evidenceRevisionId: latestRevision.entity_revision_id,
      reviewerUserId: callerUserId,
      reviewOutcome: body.review_outcome as string,
      reviewBasis: body.review_basis as string,
    });

    const updated = await repo.updateEvidenceStatus(client, {
      evidenceId,
      evidenceStatus: evidence.evidence_status,
      reviewStatus,
      newRevisionNo,
    });

    if (!updated) {
      throw new HttpError("NOT_FOUND", `Evidence ${evidenceId} was not found`);
    }

    await createRevision(client, {
      entityId: evidenceId,
      revisionNo: newRevisionNo,
      content: {
        assertion_text: updated.assertion_text,
        evidence_status: updated.evidence_status,
        review_status: updated.review_status,
      },
      createdBy: callerUserId,
      changeSummary: "Evidence reviewed",
    });

    return { evidence: updated, review };
  });

  return { data: result };
}

export interface CreateConfirmationInput {
  authority_id?: unknown;
  confirming_stakeholder_id?: unknown;
  confirmation_outcome?: unknown;
  evidence_basis?: unknown;
  occurred_at?: unknown;
}

/**
 * Records a confirmation event. Per FR-014 AC-03 ("Evidence Confirmed
 * must have a reviewer, source, confirming basis, and version"), a
 * CONFIRMED outcome requires a currently-valid authority_id - this is
 * the one place that rule is actually enforced, not merely documented.
 * A REJECTED or REQUIRES_CLARIFICATION outcome does not require
 * authority (there is nothing to authorize).
 */
export async function confirmEvidenceService(
  evidenceId: string,
  body: CreateConfirmationInput,
  callerUserId: string,
) {
  if (!isUuid(evidenceId)) {
    throw new HttpError("VALIDATION_ERROR", "evidence_id must be a valid UUID");
  }
  const evidence = await repo.findEvidenceById(evidenceId);
  if (!evidence) {
    throw new HttpError("NOT_FOUND", `Evidence ${evidenceId} was not found`);
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
  if (!isNonEmptyString(body.evidence_basis)) {
    throw new HttpError("VALIDATION_ERROR", "evidence_basis is required");
  }

  const authorityId =
    typeof body.authority_id === "string" && body.authority_id.trim() ? body.authority_id : null;
  if (authorityId !== null && !isUuid(authorityId)) {
    throw new HttpError("VALIDATION_ERROR", "authority_id must be a valid UUID when provided");
  }

  if (body.confirmation_outcome === "CONFIRMED") {
    if (!authorityId) {
      throw new HttpError(
        "VALIDATION_ERROR",
        "authority_id is required when confirmation_outcome is CONFIRMED",
      );
    }
    const valid = await isAuthorityCurrentlyValid(authorityId);
    if (!valid) {
      throw new HttpError(
        "VALIDATION_ERROR",
        "authority_id does not refer to a currently valid authority grant",
      );
    }
  }

  const confirmingStakeholderId =
    typeof body.confirming_stakeholder_id === "string" && body.confirming_stakeholder_id.trim()
      ? body.confirming_stakeholder_id
      : null;
  if (confirmingStakeholderId !== null && !isUuid(confirmingStakeholderId)) {
    throw new HttpError(
      "VALIDATION_ERROR",
      "confirming_stakeholder_id must be a valid UUID when provided",
    );
  }

  let occurredAt = new Date().toISOString();
  if (typeof body.occurred_at === "string") {
    const parsedMs = Date.parse(body.occurred_at);
    if (isNaN(parsedMs)) {
      throw new HttpError("VALIDATION_ERROR", "occurred_at must be a valid ISO timestamp when provided");
    }
    occurredAt = new Date(parsedMs).toISOString();
  }

  const latestRevision = await repo.findLatestRevision(evidenceId);
  if (!latestRevision) {
    throw new HttpError("INTERNAL_ERROR", "No revision history found for this evidence");
  }

  const newEvidenceStatus =
    body.confirmation_outcome === "CONFIRMED"
      ? "CONFIRMED"
      : evidence.evidence_status;
  const newRevisionNo = evidence.current_revision_no + 1;

  const result = await withTransaction(async (client) => {
    const confirmation = await repo.insertConfirmationRecord(client, {
      evidenceId,
      evidenceRevisionId: latestRevision.entity_revision_id,
      authorityId,
      confirmingStakeholderId,
      confirmationOutcome: body.confirmation_outcome as string,
      evidenceBasis: body.evidence_basis as string,
      authoritySnapshot: authorityId ? { authority_id: authorityId, checked_at: new Date().toISOString() } : null,
      occurredAt,
      recordedBy: callerUserId,
    });

    const updated = await repo.updateEvidenceStatus(client, {
      evidenceId,
      evidenceStatus: newEvidenceStatus,
      reviewStatus: evidence.review_status,
      newRevisionNo,
    });

    if (!updated) {
      throw new HttpError("NOT_FOUND", `Evidence ${evidenceId} was not found`);
    }

    await createRevision(client, {
      entityId: evidenceId,
      revisionNo: newRevisionNo,
      content: {
        assertion_text: updated.assertion_text,
        evidence_status: updated.evidence_status,
        review_status: updated.review_status,
      },
      createdBy: callerUserId,
      changeSummary: "Evidence confirmation recorded",
    });

    return { evidence: updated, confirmation };
  });

  return { data: result };
}
