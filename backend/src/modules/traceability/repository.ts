// Shared infrastructure for traceability_relations / relation_revisions
// (FR-016). Used wherever a module needs to record a typed link
// between two registered entities - currently only
// DECOMPOSED_FROM (Requirement split, FR-018), but written generic
// enough for any future RELATION_TYPE without needing its own
// repository module.

import type { PoolClient } from "pg";
import { getPool } from "../../db/pool.js";

export interface TraceabilityRelationRow {
  relation_id: string;
  relation_type_version_id: string;
  source_entity_id: string;
  target_entity_id: string;
  relation_status: string;
  created_at: string;
  created_by: string;
  effective_from: string;
  effective_to: string | null;
}

export async function findActiveRelation(params: {
  relationTypeCode: string;
  sourceEntityId: string;
}): Promise<TraceabilityRelationRow | null> {
  const { rows } = await getPool().query<TraceabilityRelationRow>(
    `SELECT r.relation_id, r.relation_type_version_id, r.source_entity_id,
            r.target_entity_id, r.relation_status, r.created_at, r.created_by,
            r.effective_from, r.effective_to
     FROM traceability_relations r
     JOIN definition_versions dv ON dv.definition_version_id = r.relation_type_version_id
     WHERE dv.definition_code = $1
       AND r.source_entity_id = $2
       AND r.relation_status = 'ACTIVE'`,
    [params.relationTypeCode, params.sourceEntityId],
  );
  return rows[0] ?? null;
}

export interface RelationTypeDefinition {
  definition_version_id: string;
  source_role: string;
  target_role: string;
}

export async function findActiveRelationTypeVersionId(
  relationTypeCode: string,
): Promise<string | null> {
  const { rows } = await getPool().query<{ definition_version_id: string }>(
    `SELECT definition_version_id FROM definition_versions
     WHERE definition_type = 'RELATION_TYPE' AND definition_code = $1 AND status = 'ACTIVE'`,
    [relationTypeCode],
  );
  return rows[0]?.definition_version_id ?? null;
}

/**
 * Resolves a RELATION_TYPE definition including its declared
 * source_role/target_role (stored in definition_body at seed time -
 * see migrations 007/011) - used to validate that the two entity_id
 * values a caller supplies to the generic Traceability API actually
 * carry the entity_type the relation type expects, not just that
 * they're well-formed UUIDs.
 */
export async function findActiveRelationTypeDefinition(
  relationTypeCode: string,
): Promise<RelationTypeDefinition | null> {
  const { rows } = await getPool().query<RelationTypeDefinition>(
    `SELECT definition_version_id,
            definition_body->>'source_role' AS source_role,
            definition_body->>'target_role' AS target_role
     FROM definition_versions
     WHERE definition_type = 'RELATION_TYPE' AND definition_code = $1 AND status = 'ACTIVE'`,
    [relationTypeCode],
  );
  return rows[0] ?? null;
}

/**
 * Looks up the entity_type an entity was registered with
 * (entity_identities.entity_type), used to validate it matches a
 * relation type's expected source_role/target_role before linking.
 */
export async function findEntityType(entityId: string): Promise<string | null> {
  const { rows } = await getPool().query<{ entity_type: string }>(
    `SELECT entity_type FROM entity_identities WHERE entity_id = $1`,
    [entityId],
  );
  return rows[0]?.entity_type ?? null;
}

/**
 * Looks up the owning case_id for an entity, where that concept
 * applies - tries each table known to have a case_id column and a FK
 * to entity_identities on its PK. Returns null for entity types that
 * either don't exist or have no single owning Case (there are none
 * of those yet among registered entity types, but the function is
 * written to degrade to null rather than throw if one is ever added).
 * Used only by callers that explicitly require same-Case ownership -
 * general traceability reads/writes do NOT call this, per the
 * approved "cross-case linking allowed" rule.
 */
export async function findOwningCaseId(entityId: string, entityType: string): Promise<string | null> {
  const tableByType: Record<string, string> = {
    EVIDENCE: "evidence",
    BUSINESS_DECISION: "business_decisions",
    REQUIREMENT: "requirements",
  };
  const table = tableByType[entityType];
  if (!table) return null;

  const idColumnByTable: Record<string, string> = {
    evidence: "evidence_id",
    business_decisions: "decision_id",
    requirements: "requirement_id",
  };
  const idColumn = idColumnByTable[table]!;

  // table/idColumn are never derived from request input - both come
  // from the two fixed lookup maps above, keyed only by entityType
  // values this function already validated against. Interpolating
  // them into the query string is safe for that reason; entityId
  // (the only actual untrusted value here) is always passed as a
  // bound parameter.
  const { rows } = await getPool().query<{ case_id: string }>(
    `SELECT case_id FROM ${table} WHERE ${idColumn} = $1`,
    [entityId],
  );
  return rows[0]?.case_id ?? null;
}

export async function insertRelation(
  client: PoolClient,
  params: {
    relationTypeVersionId: string;
    sourceEntityId: string;
    targetEntityId: string;
    createdBy: string;
  },
): Promise<TraceabilityRelationRow> {
  const { rows } = await client.query<TraceabilityRelationRow>(
    `INSERT INTO traceability_relations
       (relation_type_version_id, source_entity_id, target_entity_id, created_by)
     VALUES ($1, $2, $3, $4)
     RETURNING relation_id, relation_type_version_id, source_entity_id, target_entity_id,
               relation_status, created_at, created_by, effective_from, effective_to`,
    [params.relationTypeVersionId, params.sourceEntityId, params.targetEntityId, params.createdBy],
  );
  return rows[0]!;
}

export async function insertRelationRevision(
  client: PoolClient,
  params: {
    relationId: string;
    revisionNo: number;
    relationAction: "CREATE" | "UPDATE" | "RETIRE";
    relationPayload: unknown;
    changedBy: string;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO relation_revisions
       (relation_id, revision_no, relation_action, relation_payload, changed_by)
     VALUES ($1, $2, $3, $4::jsonb, $5)`,
    [
      params.relationId,
      params.revisionNo,
      params.relationAction,
      JSON.stringify(params.relationPayload),
      params.changedBy,
    ],
  );
}

export interface RelationRevisionRow {
  relation_revision_id: string;
  relation_id: string;
  revision_no: number;
  relation_action: string;
  source_entity_revision_id: string | null;
  target_entity_revision_id: string | null;
  relation_payload: unknown;
  changed_at: string;
  changed_by: string;
}

/**
 * Exact-revision lookup for a relation, by the relation's own
 * revision_id - same shape and same "wrong relation_id for this
 * relation_id pair reads as not-found" guarantee as entities/
 * repository.ts's findRevisionById, via relation_revisions'
 * UNIQUE(relation_id, revision_no); there is no separate uniqueness
 * constraint pairing (relation_id, relation_revision_id) the way
 * entity_revisions has uq_entity_revision_entity_pair, but relation_
 * revision_id is this table's own primary key, so filtering by both
 * columns here still only ever matches the one row that is actually
 * relationId's, exactly like the entity-side lookup.
 */
export async function findRelationRevisionById(
  relationId: string,
  relationRevisionId: string,
): Promise<RelationRevisionRow | null> {
  const { rows } = await getPool().query<RelationRevisionRow>(
    `SELECT relation_revision_id, relation_id, revision_no, relation_action,
            source_entity_revision_id, target_entity_revision_id, relation_payload,
            changed_at, changed_by
     FROM relation_revisions
     WHERE relation_revision_id = $1 AND relation_id = $2`,
    [relationRevisionId, relationId],
  );
  return rows[0] ?? null;
}

/** Same as findRelationRevisionById, addressed by revision_no instead. */
export async function findRelationRevisionByNo(
  relationId: string,
  revisionNo: number,
): Promise<RelationRevisionRow | null> {
  const { rows } = await getPool().query<RelationRevisionRow>(
    `SELECT relation_revision_id, relation_id, revision_no, relation_action,
            source_entity_revision_id, target_entity_revision_id, relation_payload,
            changed_at, changed_by
     FROM relation_revisions
     WHERE relation_id = $1 AND revision_no = $2`,
    [relationId, revisionNo],
  );
  return rows[0] ?? null;
}

/**
 * Resolves the current (highest revision_no) relation_revisions row
 * for a relation_id - same purpose as validation/repository.ts's
 * findCurrentEntityRevisionId, for the relation side. Used by B2.2's
 * provenance representation so a REFERENCED_ONLY dependency's
 * manifest item can record not just which entity_revision it pins,
 * but which exact relation_revision justified pulling it in.
 */
export async function findCurrentRelationRevisionId(relationId: string): Promise<string | null> {
  const { rows } = await getPool().query<{ relation_revision_id: string }>(
    `SELECT relation_revision_id FROM relation_revisions
     WHERE relation_id = $1
     ORDER BY revision_no DESC
     LIMIT 1`,
    [relationId],
  );
  return rows[0]?.relation_revision_id ?? null;
}

/** True if relationId has at least one traceability_relations row. */
export async function relationExists(relationId: string): Promise<boolean> {
  const { rows } = await getPool().query<{ exists: boolean }>(
    `SELECT EXISTS(SELECT 1 FROM traceability_relations WHERE relation_id = $1) AS exists`,
    [relationId],
  );
  return rows[0]?.exists ?? false;
}

/**
 * Classification-only lookup, same purpose as entities/repository.ts's
 * revisionIdExistsForAnyEntity: does relation_revision_id exist at
 * all, regardless of which relation it belongs to. Never used to
 * return that row's content to a caller.
 */
export async function relationRevisionIdExistsForAnyRelation(
  relationRevisionId: string,
): Promise<boolean> {
  const { rows } = await getPool().query<{ exists: boolean }>(
    `SELECT EXISTS(SELECT 1 FROM relation_revisions WHERE relation_revision_id = $1) AS exists`,
    [relationRevisionId],
  );
  return rows[0]?.exists ?? false;
}

export interface RelationView {
  relation_id: string;
  relation_type_code: string;
  source_entity_id: string;
  target_entity_id: string;
  relation_status: string;
  created_at: string;
  effective_from: string;
  effective_to: string | null;
}

/**
 * Returns every relation (in either direction) involving a given
 * entity, with the relation type's definition_code resolved for
 * display - backs GET /api/entities/:entityId/relations (FR-016
 * AC-01, "BA can see the source and version used as basis for a
 * requirement/AC"). Deliberately does not filter by Case: per the
 * Data Dictionary's own note on TraceabilityRelation ("cross-case
 * linking allowed, ownership unchanged"), a relation can legitimately
 * span two different Cases, so this read-only lookup returns
 * everything regardless of which Case either endpoint belongs to -
 * only operations explicitly requiring same-Case ownership (like
 * Requirement Split) enforce that separately, not this general
 * traceability read.
 */
export async function findRelationsByEntityId(entityId: string): Promise<RelationView[]> {
  const { rows } = await getPool().query<RelationView>(
    `SELECT r.relation_id, dv.definition_code AS relation_type_code, r.source_entity_id,
            r.target_entity_id, r.relation_status, r.created_at, r.effective_from,
            r.effective_to
     FROM traceability_relations r
     JOIN definition_versions dv ON dv.definition_version_id = r.relation_type_version_id
     WHERE r.source_entity_id = $1 OR r.target_entity_id = $1
     ORDER BY r.created_at ASC`,
    [entityId],
  );
  return rows;
}

/**
 * Detects a decomposition cycle: would linking `childEntityId` under
 * `parentEntityId` (via DECOMPOSED_FROM) create a cycle, i.e. is
 * `parentEntityId` already a (direct or transitive) descendant of
 * `childEntityId`? Walks the existing ACTIVE DECOMPOSED_FROM chain
 * upward from `parentEntityId` looking for `childEntityId`.
 */
export async function wouldCreateDecompositionCycle(params: {
  childEntityId: string;
  parentEntityId: string;
}): Promise<boolean> {
  if (params.childEntityId === params.parentEntityId) {
    return true;
  }
  const { rows } = await getPool().query<{ found: boolean }>(
    `WITH RECURSIVE ancestors AS (
       SELECT r.target_entity_id AS ancestor_id
       FROM traceability_relations r
       JOIN definition_versions dv ON dv.definition_version_id = r.relation_type_version_id
       WHERE dv.definition_code = 'DECOMPOSED_FROM'
         AND r.relation_status = 'ACTIVE'
         AND r.source_entity_id = $2
       UNION ALL
       SELECT r.target_entity_id
       FROM traceability_relations r
       JOIN definition_versions dv ON dv.definition_version_id = r.relation_type_version_id
       JOIN ancestors a ON a.ancestor_id = r.source_entity_id
       WHERE dv.definition_code = 'DECOMPOSED_FROM'
         AND r.relation_status = 'ACTIVE'
     )
     SELECT EXISTS (SELECT 1 FROM ancestors WHERE ancestor_id = $1) AS found`,
    [params.childEntityId, params.parentEntityId],
  );
  return rows[0]?.found ?? false;
}
