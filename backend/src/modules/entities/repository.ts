// Shared infrastructure for the EntityIdentity / EntityRevision
// pattern used by every "registered, traceable, revisioned" business
// object in the schema (Context, Scope, Discovery Answer,
// Information Gap, and later Requirement, Evidence, BusinessRule,
// etc. — any table whose PK carries a FK to entity_identities).
//
// Every module that owns such a table calls registerEntity() once
// per new row (before inserting the owning table's own row, since
// that row's PK must already exist in entity_identities to satisfy
// the FK) and createRevision() every time that row's content changes
// (both on creation and on every subsequent edit) — never UPDATE on
// entity_revisions, which is immutable by design (no UPDATE/DELETE
// grant exists on it, matching entity_revisions having none anywhere
// in the applied schema).
//
// Which tables actually carry this FK must be verified against the
// applied migration SQL directly, not assumed from the Data
// Dictionary workbook (which the workbook itself marks "PROPOSED /
// DDL NOT TESTED") — e.g. module_applications does NOT carry this FK
// even though discovery_answers and information_gaps do (added later
// by a repair migration), discovered the hard way via a live
// foreign-key violation during integration testing.

import { createHash, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { getPool } from "../../db/pool.js";

/**
 * Registers a new entity identity. Must run inside the same
 * transaction as the INSERT into the entity's own table (e.g.
 * business_contexts), since that table's PK is a FK to
 * entity_identities.entity_id and must already exist.
 *
 * Returns the new entity_id - callers use this as the PK value for
 * their own table's INSERT.
 */
export async function registerEntity(
  client: PoolClient,
  entityType: string,
): Promise<string> {
  const entityId = randomUUID();
  await client.query(
    `INSERT INTO entity_identities (entity_id, entity_type) VALUES ($1, $2)`,
    [entityId, entityType],
  );
  return entityId;
}

/**
 * Creates a new immutable revision for an entity. `content` is
 * whatever the owning module considers "the canonical state at this
 * version" (e.g. { content, knowledge_status } for a BusinessContext
 * row) - it is hashed here so every caller gets the same, correct
 * content_sha256 format (64 lowercase hex chars) without
 * reimplementing the hash call site by site.
 *
 * `revisionNo` must be exactly current_revision_no + 1 from the
 * caller's perspective (entity_revisions enforces UNIQUE(entity_id,
 * revision_no) and CHECK(revision_no > 0) - a wrong value fails loud
 * via a constraint violation rather than silently skipping a version).
 */
export async function createRevision(
  client: PoolClient,
  params: {
    entityId: string;
    revisionNo: number;
    content: unknown;
    createdBy: string;
    changeSummary?: string;
  },
): Promise<void> {
  const contentSnapshot = JSON.stringify(params.content);
  const contentSha256 = createHash("sha256").update(contentSnapshot).digest("hex");

  await client.query(
    `INSERT INTO entity_revisions
       (entity_id, revision_no, content_snapshot, content_sha256, change_summary, created_by)
     VALUES ($1, $2, $3::jsonb, $4, $5, $6)`,
    [
      params.entityId,
      params.revisionNo,
      contentSnapshot,
      contentSha256,
      params.changeSummary ?? null,
      params.createdBy,
    ],
  );
}

/**
 * Returns the highest revision_no recorded for an entity, or 0 if
 * none exists yet (so the first revision a caller writes is 1).
 * Needed for tables with no current_revision_no column of their own
 * (e.g. information_gaps) - for tables that DO carry that column
 * (business_contexts, case_scopes, discovery_answers), prefer reading
 * it directly from the already-fetched row instead of this extra
 * query, since it is kept in sync with entity_revisions by the same
 * transaction that writes both.
 */
export async function getLatestRevisionNo(
  client: PoolClient,
  entityId: string,
): Promise<number> {
  const { rows } = await client.query<{ max: number | null }>(
    `SELECT max(revision_no) AS max FROM entity_revisions WHERE entity_id = $1`,
    [entityId],
  );
  return rows[0]?.max ?? 0;
}

export interface EntityRevisionRow {
  entity_revision_id: string;
  entity_id: string;
  revision_no: number;
  content_snapshot: unknown;
  content_sha256: string;
  change_summary: string | null;
  created_at: string;
  created_by: string;
}

/**
 * Looks up one exact, immutable revision by its own revision_id -
 * never "the current one", never inferred from entity_id alone. Pass
 * entityId only as an ownership check (entity_revisions_entity_id_
 * revision_no_key / uq_entity_revision_entity_pair already guarantee
 * a given entity_revision_id belongs to exactly one entity_id, so
 * this is enforcing the caller's expectation, not discovering it):
 * returns null both when the revision_id doesn't exist at all AND
 * when it exists but belongs to a different entity, so callers can't
 * accidentally read another entity's historical content by passing
 * the wrong pair - they get the same "not found" either way and must
 * treat it as such (see getEntityRevisionService for how an id-
 * exists-but-wrong-entity case is told apart from a true 404 when a
 * caller needs that distinction, e.g. for a DATA_INTEGRITY_ERROR vs
 * NOT_FOUND response).
 */
export async function findRevisionById(
  entityId: string,
  entityRevisionId: string,
): Promise<EntityRevisionRow | null> {
  const { rows } = await getPool().query<EntityRevisionRow>(
    `SELECT entity_revision_id, entity_id, revision_no, content_snapshot,
            content_sha256, change_summary, created_at, created_by
     FROM entity_revisions
     WHERE entity_revision_id = $1 AND entity_id = $2`,
    [entityRevisionId, entityId],
  );
  return rows[0] ?? null;
}

/**
 * Same exact-revision guarantee as findRevisionById, but addressed by
 * the human-assigned revision_no (1, 2, 3, ...) instead of the
 * opaque entity_revision_id - the form a BA or a UI "revision
 * history" list would naturally use. entity_revisions' own
 * UNIQUE(entity_id, revision_no) constraint is what makes this
 * lookup unambiguous.
 */
export async function findRevisionByNo(
  entityId: string,
  revisionNo: number,
): Promise<EntityRevisionRow | null> {
  const { rows } = await getPool().query<EntityRevisionRow>(
    `SELECT entity_revision_id, entity_id, revision_no, content_snapshot,
            content_sha256, change_summary, created_at, created_by
     FROM entity_revisions
     WHERE entity_id = $1 AND revision_no = $2`,
    [entityId, revisionNo],
  );
  return rows[0] ?? null;
}

/**
 * True if entityId has at least one entity_identities row - lets a
 * caller tell "this entity was never registered at all" (its own
 * NOT_FOUND) apart from "this entity exists but the specific
 * revision_id/revision_no requested does not belong to it" (a
 * revision/entity mismatch, surfaced by the two lookups above
 * returning null despite the entity itself being real).
 */
export async function entityExists(entityId: string): Promise<boolean> {
  const { rows } = await getPool().query<{ exists: boolean }>(
    `SELECT EXISTS(SELECT 1 FROM entity_identities WHERE entity_id = $1) AS exists`,
    [entityId],
  );
  return rows[0]?.exists ?? false;
}

/**
 * Classification-only lookup: does entity_revision_id exist at all,
 * regardless of which entity it belongs to. Used solely by
 * getEntityRevisionService to tell "no such revision anywhere" (true
 * 404) apart from "that revision exists but names a different entity
 * than the caller asked for" (a mismatch, not a 404) - the row's
 * content/entity_id is intentionally not meant to be read back to the
 * caller from this path; callers that need the content must still go
 * through findRevisionById with the correct (entityId, revisionId)
 * pair.
 */
export async function revisionIdExistsForAnyEntity(entityRevisionId: string): Promise<boolean> {
  const { rows } = await getPool().query<{ exists: boolean }>(
    `SELECT EXISTS(SELECT 1 FROM entity_revisions WHERE entity_revision_id = $1) AS exists`,
    [entityRevisionId],
  );
  return rows[0]?.exists ?? false;
}

// Note: revision_no has no equivalent classification helper - it is
// only unique per-entity (UNIQUE(entity_id, revision_no)), so "does
// revision_no N exist for some entity" is not a meaningful question
// the way "does this entity_revision_id exist anywhere" is. When the
// caller selects by revision_no and findRevisionByNo returns null,
// that is reported as a plain NOT_FOUND (see service.ts) - there is
// no mismatch case to distinguish for that selector form.
