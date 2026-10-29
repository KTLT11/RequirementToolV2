// Business Decision (P3-FR-014/016). decision_id carries a FK to
// entity_identities (confirmed via the repair migration) - uses
// registerEntity()/createRevision().
//
// Traceability note (P2-C): when a Decision is created with a
// source_evidence_id, an EVIDENCE_SUPPORTS_DECISION relation is
// auto-created in the same transaction (per approved instruction -
// this is the one relation type created as a side effect of another
// module's write, not through the generic Traceability API). There is
// deliberately no "sync relation on source_evidence_id update" code
// path: updateDecision() (see repository.ts) never updates
// source_evidence_id - it is immutable after creation in the current
// schema/code, so a Decision's evidence source cannot change and the
// relation never needs to be re-pointed or retired. If a future
// requirement needs source_evidence_id to be mutable, that is a
// schema/business-rule change outside this module's current scope and
// must be approved separately, not inferred here.

import { HttpError } from "../../http/errors.js";
import { withTransaction } from "../../db/pool.js";
import { registerEntity, createRevision } from "../entities/repository.js";
import {
  findActiveRelationTypeDefinition,
  insertRelation,
  insertRelationRevision,
} from "../traceability/repository.js";
import * as repo from "./repository.js";

const EVIDENCE_SUPPORTS_DECISION = "EVIDENCE_SUPPORTS_DECISION";

const DECISION_OUTCOMES = ["PROPOSED", "AGREED", "REJECTED", "SUPERSEDED"] as const;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

export async function listDecisionsService(caseId: string) {
  if (!isUuid(caseId)) {
    throw new HttpError("VALIDATION_ERROR", "case_id must be a valid UUID");
  }
  const rows = await repo.findDecisionsByCaseId(caseId);
  return { data: rows };
}

export interface CreateDecisionInput {
  decision_subject?: unknown;
  decision_text?: unknown;
  decision_outcome?: unknown;
  authority_id?: unknown;
  source_evidence_id?: unknown;
  effective_from?: unknown;
  effective_to?: unknown;
}

function parseOptionalTimestamp(value: unknown, fieldName: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    throw new HttpError("VALIDATION_ERROR", `${fieldName} must be a valid ISO timestamp when provided`);
  }
  const parsedMs = Date.parse(value);
  if (isNaN(parsedMs)) {
    throw new HttpError("VALIDATION_ERROR", `${fieldName} must be a valid ISO timestamp when provided`);
  }
  return new Date(parsedMs).toISOString();
}

export async function createDecisionService(
  caseId: string,
  body: CreateDecisionInput,
  callerUserId: string,
) {
  if (!isUuid(caseId)) {
    throw new HttpError("VALIDATION_ERROR", "case_id must be a valid UUID");
  }
  if (!isNonEmptyString(body.decision_subject)) {
    throw new HttpError("VALIDATION_ERROR", "decision_subject is required");
  }
  if (!isNonEmptyString(body.decision_text)) {
    throw new HttpError("VALIDATION_ERROR", "decision_text is required");
  }
  if (
    typeof body.decision_outcome !== "string" ||
    !DECISION_OUTCOMES.includes(body.decision_outcome as (typeof DECISION_OUTCOMES)[number])
  ) {
    throw new HttpError(
      "VALIDATION_ERROR",
      `decision_outcome must be one of: ${DECISION_OUTCOMES.join(", ")}`,
    );
  }
  const authorityId =
    typeof body.authority_id === "string" && body.authority_id.trim() ? body.authority_id : null;
  if (authorityId !== null && !isUuid(authorityId)) {
    throw new HttpError("VALIDATION_ERROR", "authority_id must be a valid UUID when provided");
  }
  const sourceEvidenceId =
    typeof body.source_evidence_id === "string" && body.source_evidence_id.trim()
      ? body.source_evidence_id
      : null;
  if (sourceEvidenceId !== null && !isUuid(sourceEvidenceId)) {
    throw new HttpError("VALIDATION_ERROR", "source_evidence_id must be a valid UUID when provided");
  }

  const effectiveFrom = parseOptionalTimestamp(body.effective_from, "effective_from");
  const effectiveTo = parseOptionalTimestamp(body.effective_to, "effective_to");
  if (effectiveFrom && effectiveTo && effectiveTo <= effectiveFrom) {
    throw new HttpError("VALIDATION_ERROR", "effective_to must be after effective_from");
  }

  const result = await withTransaction(async (client) => {
    const decisionId = await registerEntity(client, "BUSINESS_DECISION");

    const created = await repo.insertDecision(client, {
      decisionId,
      caseId,
      decisionSubject: body.decision_subject as string,
      decisionText: body.decision_text as string,
      decisionOutcome: body.decision_outcome as string,
      authorityId,
      sourceEvidenceId,
      effectiveFrom,
      effectiveTo,
    });

    await createRevision(client, {
      entityId: decisionId,
      revisionNo: 1,
      content: { decision_text: created.decision_text, decision_outcome: created.decision_outcome },
      createdBy: callerUserId,
      changeSummary: "Business decision created",
    });

    if (sourceEvidenceId) {
      const relationType = await findActiveRelationTypeDefinition(EVIDENCE_SUPPORTS_DECISION);
      if (!relationType) {
        throw new HttpError(
          "INTERNAL_ERROR",
          `${EVIDENCE_SUPPORTS_DECISION} relation type is not seeded as an active RELATION_TYPE definition`,
        );
      }

      const relation = await insertRelation(client, {
        relationTypeVersionId: relationType.definition_version_id,
        sourceEntityId: sourceEvidenceId,
        targetEntityId: decisionId,
        createdBy: callerUserId,
      });

      await insertRelationRevision(client, {
        relationId: relation.relation_id,
        revisionNo: 1,
        relationAction: "CREATE",
        relationPayload: {
          relation_type: EVIDENCE_SUPPORTS_DECISION,
          source_entity_id: sourceEvidenceId,
          target_entity_id: decisionId,
        },
        changedBy: callerUserId,
      });
    }

    return created;
  });

  return { data: result };
}

export interface UpdateDecisionInput {
  decision_text?: unknown;
  decision_outcome?: unknown;
}

export async function updateDecisionService(
  decisionId: string,
  body: UpdateDecisionInput,
  callerUserId: string,
) {
  if (!isUuid(decisionId)) {
    throw new HttpError("VALIDATION_ERROR", "decision_id must be a valid UUID");
  }
  if (!isNonEmptyString(body.decision_text)) {
    throw new HttpError("VALIDATION_ERROR", "decision_text is required");
  }
  if (
    typeof body.decision_outcome !== "string" ||
    !DECISION_OUTCOMES.includes(body.decision_outcome as (typeof DECISION_OUTCOMES)[number])
  ) {
    throw new HttpError(
      "VALIDATION_ERROR",
      `decision_outcome must be one of: ${DECISION_OUTCOMES.join(", ")}`,
    );
  }

  const existing = await repo.findDecisionById(decisionId);
  if (!existing) {
    throw new HttpError("NOT_FOUND", `Business decision ${decisionId} was not found`);
  }

  const newRevisionNo = existing.current_revision_no + 1;

  const result = await withTransaction(async (client) => {
    const updated = await repo.updateDecision(client, {
      decisionId,
      decisionText: body.decision_text as string,
      decisionOutcome: body.decision_outcome as string,
      newRevisionNo,
    });

    if (!updated) {
      throw new HttpError("NOT_FOUND", `Business decision ${decisionId} was not found`);
    }

    await createRevision(client, {
      entityId: decisionId,
      revisionNo: newRevisionNo,
      content: { decision_text: updated.decision_text, decision_outcome: updated.decision_outcome },
      createdBy: callerUserId,
      changeSummary: "Business decision updated",
    });

    return updated;
  });

  return { data: result };
}
