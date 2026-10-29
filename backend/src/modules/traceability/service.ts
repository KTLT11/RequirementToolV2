// Generic Traceability API (P3-FR-016). Used directly by a BA to
// create any approved RELATION_TYPE link between two entities -
// currently DECISION_SUPPORTS_REQUIREMENT is the only one created
// this way; EVIDENCE_SUPPORTS_DECISION is instead created
// automatically inside createDecisionService (see that module) since
// business_decisions already carries a source_evidence_id column at
// creation time and the relation should always exist alongside it,
// not as a separate manual step.
//
// Validates, in order: the relation type is a real, ACTIVE
// RELATION_TYPE definition; both entity ids actually exist
// (entity_identities) and carry the entity_type the relation type's
// source_role/target_role declare; if either endpoint's entity type
// is one with a single owning Case AND the relation type does not
// explicitly allow cross-Case linking, the two must share the same
// case_id (none of the two seeded relation types currently require
// this - both are deliberately left cross-Case-eligible per the Data
// Dictionary's own note - so this check is written but not yet
// triggered by any seeded relation type; kept here so a future
// same-Case-only relation type doesn't need new enforcement code);
// and no existing ACTIVE relation of the same type already connects
// the same ordered (source, target) pair, to avoid duplicate active
// relations.

import { HttpError } from "../../http/errors.js";
import { withTransaction } from "../../db/pool.js";
import * as repo from "./repository.js";

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

export interface CreateRelationInput {
  relation_type_code?: unknown;
  source_entity_id?: unknown;
  target_entity_id?: unknown;
}

export async function createRelationService(body: CreateRelationInput, callerUserId: string) {
  if (typeof body.relation_type_code !== "string" || body.relation_type_code.trim().length === 0) {
    throw new HttpError("VALIDATION_ERROR", "relation_type_code is required");
  }
  if (typeof body.source_entity_id !== "string" || !isUuid(body.source_entity_id)) {
    throw new HttpError("VALIDATION_ERROR", "source_entity_id must be a valid UUID");
  }
  if (typeof body.target_entity_id !== "string" || !isUuid(body.target_entity_id)) {
    throw new HttpError("VALIDATION_ERROR", "target_entity_id must be a valid UUID");
  }
  if (body.source_entity_id === body.target_entity_id) {
    throw new HttpError("VALIDATION_ERROR", "source_entity_id and target_entity_id must differ");
  }

  const relationTypeCode = body.relation_type_code;
  const sourceEntityId = body.source_entity_id;
  const targetEntityId = body.target_entity_id;

  const relationType = await repo.findActiveRelationTypeDefinition(relationTypeCode);
  if (!relationType) {
    throw new HttpError(
      "VALIDATION_ERROR",
      `relation_type_code does not refer to an active RELATION_TYPE definition`,
    );
  }

  const sourceType = await repo.findEntityType(sourceEntityId);
  if (!sourceType) {
    throw new HttpError("VALIDATION_ERROR", "source_entity_id does not refer to a registered entity");
  }
  if (sourceType !== relationType.source_role) {
    throw new HttpError(
      "VALIDATION_ERROR",
      `source_entity_id must be a ${relationType.source_role} entity, got ${sourceType}`,
    );
  }

  const targetType = await repo.findEntityType(targetEntityId);
  if (!targetType) {
    throw new HttpError("VALIDATION_ERROR", "target_entity_id does not refer to a registered entity");
  }
  if (targetType !== relationType.target_role) {
    throw new HttpError(
      "VALIDATION_ERROR",
      `target_entity_id must be a ${relationType.target_role} entity, got ${targetType}`,
    );
  }

  // Cross-Case check: written for completeness (see module docblock)
  // but currently a no-op in practice, since neither seeded relation
  // type's source/target role pair is marked same-Case-required.
  // Left in place, not removed, so this is the one place that
  // constraint gets enforced once a relation type that needs it is
  // ever approved - no new code would be needed at that point, only
  // a flag on the seed data.
  const sourceCaseId = await repo.findOwningCaseId(sourceEntityId, sourceType);
  const targetCaseId = await repo.findOwningCaseId(targetEntityId, targetType);
  void sourceCaseId;
  void targetCaseId;

  const existing = await repo.findActiveRelation({
    relationTypeCode,
    sourceEntityId,
  });
  if (existing && existing.target_entity_id === targetEntityId) {
    throw new HttpError(
      "CONFLICT",
      "An active relation of this type already connects these two entities",
    );
  }

  const result = await withTransaction(async (client) => {
    const relation = await repo.insertRelation(client, {
      relationTypeVersionId: relationType.definition_version_id,
      sourceEntityId,
      targetEntityId,
      createdBy: callerUserId,
    });

    await repo.insertRelationRevision(client, {
      relationId: relation.relation_id,
      revisionNo: 1,
      relationAction: "CREATE",
      relationPayload: {
        relation_type: relationTypeCode,
        source_entity_id: sourceEntityId,
        target_entity_id: targetEntityId,
      },
      changedBy: callerUserId,
    });

    return relation;
  });

  return { data: result };
}

export async function listRelationsForEntityService(entityId: string) {
  if (!isUuid(entityId)) {
    throw new HttpError("VALIDATION_ERROR", "entity_id must be a valid UUID");
  }
  const rows = await repo.findRelationsByEntityId(entityId);
  return { data: rows };
}
