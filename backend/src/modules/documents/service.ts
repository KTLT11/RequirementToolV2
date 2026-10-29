// Document, DocumentSnapshot, DocumentPublication (Phase 6 P3 —
// Confirmation, Document, Publication, Development Handoff).
//
// SCOPE NOTE (explicit, per instruction): this module does NOT build
// an IDM (Intermediate Document Model) or render CRD/DRD content
// according to QG-06 v1.3's 22-section specification. That is a
// separate, much larger piece of work requiring its own approved
// architecture (document generation engine, G1/G2/G3 rules, HTML/DOCX/
// PDF rendering choice) - explicitly deferred to a future session.
// This module only provides the INFRASTRUCTURE QG-06/FR-028C actually
// needs underneath any future generator: an immutable, provenance-
// checked snapshot mechanism, publication, and (in separate modules)
// Customer Confirmation / Handoff / Dev Review that reference exact
// snapshot/manifest/scope.
//
// "Document Model with structure and provenance, not tied to a
// rendering format" (per the explicit instruction) is implemented as
// follows: createSnapshotService accepts a `content` JSON value (the
// document's structured representation - shape intentionally NOT
// dictated by this module, since defining that shape IS the deferred
// IDM/QG-06 work) plus an explicit `scope` array of entity ids the
// content claims to be about. The service:
//   1. Resolves each scoped entity's CURRENT entity_revisions row.
//   1b. (B2.1) Resolves the dependency closure outward from that
//      scope (dependency-closure.ts) and pins whatever it finds as
//      REFERENCED_ONLY, alongside - never instead of, never promoted
//      into - the caller's own INCLUDED/CONFIRMABLE selection.
//   2. Creates a DOCUMENT-purpose baseline_manifests, pins both the
//      scope's and the closure's entity revisions as manifest_items,
//      and freezes it - this is the actual "provenance" record: a
//      frozen, content-addressed list of exactly which canonical
//      source revisions the snapshot claims to represent (scope) or
//      depends on for context (closure). A caller cannot submit
//      arbitrary content and have it silently accepted as official -
//      the scope and its closure must each resolve to real, existing
//      entity revisions, or the call fails before any snapshot row is
//      written.
//   3. Hashes the content itself server-side (content_sha256) - never
//      accepts a client-supplied hash, so the hash is always a true
//      fingerprint of what was actually stored, not an unverified claim.
//   4. Stores content_mime_type = 'application/vnd.rt.document-model+json'
//      (a format-neutral marker for "structured Document Model JSON",
//      not any of HTML/DOCX/PDF) and content as JSON in
//      storage_object_path is NOT used for inline storage - no Storage/
//      file integration exists in this MVP slice, so the content itself
//      is persisted in result_details-equivalent fashion: see
//      insertDocumentSnapshotWithContent below for exactly where.
//
// A snapshot created this way is immutable the instant it exists
// (rt_protect_document_snapshot enforces this at the DB level - see
// migration 018's comment) and can only ever be superseded by creating
// a NEW document (new snapshot_version), never edited in place.

import { createHash } from "node:crypto";
import { HttpError } from "../../http/errors.js";
import { withTransaction } from "../../db/pool.js";
import {
  findCurrentEntityRevisionId,
  insertDraftManifest,
  freezeManifest,
  insertEntityRevisionManifestItem,
  findConfirmableManifestItemsByManifestId,
} from "../validation/repository.js";
import { findEntityType } from "../traceability/repository.js";
import { findConfirmationsByPublicationId } from "../confirmations/repository.js";
import { resolveDependencyClosure } from "./dependency-closure.js";
import type { ResolvedSourcePackageRef } from "./document-model/types.js";
import * as repo from "./repository.js";

const DOCUMENT_MODEL_MIME_TYPE = "application/vnd.rt.document-model+json";

/**
 * Canonical JSON serialization: object keys are sorted recursively
 * before stringifying, so the same logical content always produces
 * the same byte sequence (and therefore the same content_sha256)
 * regardless of the key order a caller happened to send. Arrays keep
 * their given order (order is meaningful there - e.g. a list of
 * sections - unlike object key order, which JSON treats as
 * insignificant). This is the ONE place content_sha256 is computed
 * from, and insertSnapshotContent always persists the value this
 * function was called on - hash and stored content can never diverge.
 */
function canonicalSerialize(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep);
  }
  if (value !== null && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

/**
 * B3.3 — shape validation for `expected_source_package` (an opaque
 * client-supplied value until checked here). Deliberately permissive
 * about currently-unused fields on each entry (e.g. supporting_paths
 * elements beyond relation_id/relation_revision_id) - this validates
 * only what the comparison in createSnapshotService actually reads,
 * not a full schema match, so a caller passing the exact
 * ResolvedSourcePackageRef shape document-model/preview.ts produces
 * always validates successfully.
 */
function parseExpectedSourcePackage(value: unknown): ResolvedSourcePackageRef | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError("VALIDATION_ERROR", "expected_source_package must be an object when provided");
  }
  const obj = value as Record<string, unknown>;
  if (!Array.isArray(obj.scope)) {
    throw new HttpError("VALIDATION_ERROR", "expected_source_package.scope must be an array");
  }
  if (!Array.isArray(obj.referenced_only)) {
    throw new HttpError("VALIDATION_ERROR", "expected_source_package.referenced_only must be an array");
  }
  for (const entry of obj.scope) {
    if (
      typeof entry !== "object" ||
      entry === null ||
      typeof (entry as Record<string, unknown>).entity_id !== "string" ||
      typeof (entry as Record<string, unknown>).entity_revision_id !== "string" ||
      ((entry as Record<string, unknown>).membership !== "INCLUDED" &&
        (entry as Record<string, unknown>).membership !== "CONFIRMABLE")
    ) {
      throw new HttpError(
        "VALIDATION_ERROR",
        "expected_source_package.scope entries must each have entity_id, entity_revision_id, and membership (INCLUDED|CONFIRMABLE)",
      );
    }
  }
  for (const entry of obj.referenced_only) {
    if (
      typeof entry !== "object" ||
      entry === null ||
      typeof (entry as Record<string, unknown>).entity_id !== "string" ||
      typeof (entry as Record<string, unknown>).entity_revision_id !== "string" ||
      !Array.isArray((entry as Record<string, unknown>).supporting_paths)
    ) {
      throw new HttpError(
        "VALIDATION_ERROR",
        "expected_source_package.referenced_only entries must each have entity_id, entity_revision_id, and a supporting_paths array",
      );
    }
    for (const path of (entry as Record<string, unknown>).supporting_paths as unknown[]) {
      if (
        typeof path !== "object" ||
        path === null ||
        typeof (path as Record<string, unknown>).relation_id !== "string" ||
        typeof (path as Record<string, unknown>).relation_revision_id !== "string"
      ) {
        throw new HttpError(
          "VALIDATION_ERROR",
          "expected_source_package.referenced_only[].supporting_paths entries must each have relation_id and relation_revision_id",
        );
      }
    }
  }
  return value as ResolvedSourcePackageRef;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

const DOCUMENT_TYPES = ["CRD", "DRD"] as const;

export async function listDocumentsService(caseId: string) {
  if (!isUuid(caseId)) {
    throw new HttpError("VALIDATION_ERROR", "case_id must be a valid UUID");
  }
  const rows = await repo.findDocumentsByCaseId(caseId);
  return { data: rows };
}

export async function getDocumentService(documentId: string) {
  if (!isUuid(documentId)) {
    throw new HttpError("VALIDATION_ERROR", "document_id must be a valid UUID");
  }
  const document = await repo.findDocumentById(documentId);
  if (!document) {
    throw new HttpError("NOT_FOUND", `Document ${documentId} was not found`);
  }
  const snapshots = await repo.findSnapshotsByDocumentId(documentId);
  const publications = await repo.findPublicationsByDocumentId(documentId);
  return { data: { ...document, snapshots, publications } };
}

export interface CreateDocumentInput {
  document_type?: unknown;
  document_name?: unknown;
}

export async function createDocumentService(
  caseId: string,
  body: CreateDocumentInput,
  callerUserId: string,
) {
  if (!isUuid(caseId)) {
    throw new HttpError("VALIDATION_ERROR", "case_id must be a valid UUID");
  }
  if (
    typeof body.document_type !== "string" ||
    !DOCUMENT_TYPES.includes(body.document_type as (typeof DOCUMENT_TYPES)[number])
  ) {
    throw new HttpError("VALIDATION_ERROR", `document_type must be one of: ${DOCUMENT_TYPES.join(", ")}`);
  }
  if (!isNonEmptyString(body.document_name)) {
    throw new HttpError("VALIDATION_ERROR", "document_name is required");
  }

  const result = await withTransaction((client) =>
    repo.insertDocument(client, {
      caseId,
      documentType: body.document_type as string,
      documentName: body.document_name as string,
      createdBy: callerUserId,
    }),
  );

  return { data: result };
}

export interface CreateSnapshotInput {
  content?: unknown;
  scope_entity_ids?: unknown;
  confirmable_entity_ids?: unknown;
  // B3.3 — optional. When provided (typically the source_package_ref
  // a Working Preview already returned - see document-model/preview.ts),
  // this call's own freshly re-resolved scope/closure is compared
  // against it on all four axes (entity revision, relation revision,
  // dependency path, membership) before any write - see
  // createSnapshotService's own comment for the exact contract.
  // Omitting it preserves the exact legacy behavior (B2.1-B2.3): no
  // comparison is performed, backward compatible for every existing
  // caller.
  expected_source_package?: unknown;
}

/**
 * Creates an immutable snapshot with explicit, verified provenance.
 * `content` is an opaque JSON value from this module's point of view -
 * its internal shape (sections, fields, G1/G2/G3 markers per QG-06) is
 * deliberately NOT defined or validated here, since that is the
 * deferred Document Generation Engine's responsibility. What IS
 * enforced here is that `scope_entity_ids` names real, currently
 * existing entities this snapshot claims to represent - each one is
 * resolved to its CURRENT entity_revisions row and pinned into a
 * frozen, DOCUMENT-purpose manifest before the snapshot can be
 * created. A caller cannot name an entity that doesn't exist, or
 * silently skip provenance - every element of scope_entity_ids must
 * resolve or the whole call fails with no snapshot/manifest written.
 *
 * `confirmable_entity_ids` (optional, must be a subset of
 * scope_entity_ids) selects which of the scoped items are given
 * membership_role = 'CONFIRMABLE' instead of the default 'INCLUDED' -
 * per the approved convention (no new table/column, reusing the
 * schema's existing single-valued membership_role column):
 *   INCLUDED     — part of the document scope, not individually
 *                  confirmable on its own.
 *   CONFIRMABLE  — part of the document scope AND eligible for a
 *                  future CustomerConfirmation's ConfirmationScopeItem
 *                  to reference (rt_guard_confirmation_scope, unchanged,
 *                  still requires exactly this value).
 * Both values mean "in scope" - any code that needs "is this item
 * part of the selected document scope" must treat INCLUDED and
 * CONFIRMABLE as equivalent (see findScopeManifestItems-style queries
 * elsewhere), never filter to only one. An item can never be both at
 * once (single column, one value) - a caller choosing confirmable_
 * entity_ids is choosing CONFIRMABLE over INCLUDED for that id, not
 * adding a second label.
 *
 * REFERENCED_ONLY is not settable directly through this endpoint's
 * input (there is no referenced_only_entity_ids parameter) - it is
 * produced automatically by B2.1's dependency closure
 * (dependency-closure.ts's resolveDependencyClosure), which walks the
 * 4 approved RELATION_TYPEs (RULE_APPLIES_TO_REQUIREMENT,
 * REQUIREMENT_FOLLOWS_WORKFLOW, RULE_REFERENCES_DATA_DEFINITION,
 * DECISION_SUPPORTS_RULE) outward from the selected scope and pins
 * whatever it finds as REFERENCED_ONLY, never promoting anything into
 * INCLUDED/CONFIRMABLE and never altering the caller's own selection.
 *
 * `expected_source_package` (B3.3, optional): the exact source package
 * a Working Preview already resolved and showed a BA (document-model/
 * preview.ts's WorkingPreviewResult.source_package_ref). When provided,
 * this call's own freshly re-resolved scope + closure (computed exactly
 * as it always has been, from scope_entity_ids - NOT read from the
 * caller's expected package, which is a comparison target only, never
 * a substitute for re-resolving) is compared against it on all four
 * axes before any write:
 *   1. Entity revision  - every scope AND referenced_only entity_id
 *      present in expected_source_package must still resolve to the
 *      SAME entity_revision_id now.
 *   2. Relation revision - every supporting_paths entry's
 *      relation_revision_id for a given referenced_only entity must
 *      still match what is freshly resolved now.
 *   3. Dependency path   - the SET of (entity_id, relation_id) pairs
 *      across all referenced_only entries must match exactly - a path
 *      present in one but not the other (a dependency appearing,
 *      disappearing, or losing/gaining a supporting relation) is a
 *      mismatch, even if entity_revision_id itself did not change.
 *   4. Membership        - every scope entity's INCLUDED/CONFIRMABLE
 *      label, and every referenced_only entity's continued REFERENCED_
 *      ONLY-only status (not promoted/not now part of scope), must
 *      match.
 * Any mismatch on any axis throws CONFLICT before the transaction
 * writes anything (see the in-transaction comparison below for exactly
 * where and why this runs on the same connection as the writes).
 * Omitting `expected_source_package` entirely preserves the EXACT
 * legacy behavior this function has had since B2.1 - no comparison is
 * performed, scope/closure are resolved and pinned exactly as before,
 * fully backward compatible for every existing caller (createSnapshotService's
 * own integration tests from B2.1 onward call it this way and must
 * keep passing unchanged).
 */
export async function createSnapshotService(
  documentId: string,
  body: CreateSnapshotInput,
  callerUserId: string,
) {
  if (!isUuid(documentId)) {
    throw new HttpError("VALIDATION_ERROR", "document_id must be a valid UUID");
  }
  const document = await repo.findDocumentById(documentId);
  if (!document) {
    throw new HttpError("NOT_FOUND", `Document ${documentId} was not found`);
  }

  if (body.content === undefined || body.content === null) {
    throw new HttpError("VALIDATION_ERROR", "content is required");
  }
  if (!Array.isArray(body.scope_entity_ids) || body.scope_entity_ids.length === 0) {
    throw new HttpError(
      "VALIDATION_ERROR",
      "scope_entity_ids must be a non-empty array naming the entities this snapshot's content represents",
    );
  }
  const scopeEntityIds = body.scope_entity_ids as unknown[];
  for (let i = 0; i < scopeEntityIds.length; i++) {
    const id = scopeEntityIds[i];
    if (typeof id !== "string" || !isUuid(id)) {
      throw new HttpError("VALIDATION_ERROR", `scope_entity_ids[${i}] must be a valid UUID`);
    }
  }

  const confirmableEntityIds = new Set<string>(
    Array.isArray(body.confirmable_entity_ids) ? (body.confirmable_entity_ids as unknown[]) as string[] : [],
  );
  let i = 0;
  for (const id of confirmableEntityIds) {
    if (typeof id !== "string" || !isUuid(id)) {
      throw new HttpError("VALIDATION_ERROR", `confirmable_entity_ids[${i}] must be a valid UUID`);
    }
    if (!(scopeEntityIds as string[]).includes(id)) {
      throw new HttpError(
        "VALIDATION_ERROR",
        `confirmable_entity_ids[${i}] (${id}) must also be present in scope_entity_ids`,
      );
    }
    i++;
  }

  const expectedSourcePackage = parseExpectedSourcePackage(body.expected_source_package);

  // Resolve provenance BEFORE any write: every scoped entity must
  // exist (entity_identities) and have at least one revision. A
  // mistyped or fabricated id fails loud here, not partway through
  // the manifest freeze.
  const entityRevisionIds: string[] = [];
  const entityRevisionIdByEntityId = new Map<string, string>();
  for (const entityId of scopeEntityIds as string[]) {
    const entityType = await findEntityType(entityId);
    if (!entityType) {
      throw new HttpError(
        "VALIDATION_ERROR",
        `scope_entity_ids references ${entityId}, which is not a registered entity`,
      );
    }
    const entityRevisionId = await findCurrentEntityRevisionId(entityId);
    if (!entityRevisionId) {
      throw new HttpError(
        "VALIDATION_ERROR",
        `scope_entity_ids references ${entityId}, which has no recorded revision`,
      );
    }
    entityRevisionIds.push(entityRevisionId);
    entityRevisionIdByEntityId.set(entityId, entityRevisionId);
  }

  // B2.1 — Dependency Closure. Resolved BEFORE any write, same
  // resolve-before-write discipline as the selected scope above: every
  // dependency this call will pin must resolve to a real entity + a
  // real current revision, or the whole call fails before any
  // manifest/snapshot row is written (see dependency-closure.ts's own
  // error handling - it throws rather than silently dropping an
  // unresolvable dependency). The selected scope itself is NEVER
  // altered by this - resolveDependencyClosure only ever returns
  // entities outside scopeEntityIds (it is seeded with the scope as
  // already-visited), so INCLUDED/CONFIRMABLE membership for the
  // caller's own selection is untouched.
  const referencedOnly = await resolveDependencyClosure(scopeEntityIds as string[]);

  // canonicalSerialize is the single source of truth for both the hash
  // and the exact bytes conceptually represented by content_sha256 -
  // insertSnapshotContent stores body.content as-is (jsonb normalizes
  // key order itself on read, but the hash is always computed from
  // this canonical form so it is reproducible/verifiable independent
  // of jsonb's own storage representation).
  const canonicalContent = canonicalSerialize(body.content);
  const contentSha256 = createHash("sha256").update(canonicalContent).digest("hex");
  const nextVersion = (await repo.findMaxSnapshotVersion(documentId)) + 1;

  const result = await withTransaction(async (client) => {
    // B2.3 — source-package consistency check, corrected. Scope
    // revisions were resolved in one pass above, then the dependency
    // closure resolved its own revisions in a separate, later pass -
    // two reads not wrapped in one transaction, so a concurrent
    // update to any of these entities between those two reads could
    // mean the set about to be pinned is no longer "current" for all
    // of them at the same instant.
    //
    // CORRECTED FROM B2.2: the re-check below now passes `client`
    // explicitly to findCurrentEntityRevisionId, so this query runs on
    // the SAME connection/transaction as the INSERTs that follow. The
    // B2.2 version omitted `client`, which meant findCurrentEntityRevisionId
    // ran its SELECT through a different pooled connection entirely -
    // still useful as a sanity re-read, but not actually happening
    // "inside this transaction" in any way that READ COMMITTED's
    // per-statement visibility rules would treat specially; it was
    // just another ordinary read racing the same way the original two
    // reads did, just closer in time to the writes.
    //
    // ACTUAL GUARANTEE WITH `client` (stated precisely, not overstated):
    // entity_revisions is append-only (no UPDATE/DELETE grant exists on
    // it anywhere in this schema) and every write path creates a new
    // row via createRevision() without first taking any lock on
    // entity_identities or entity_revisions that a reader could
    // acquire to block it (confirmed by reading every current call
    // site of createRevision()) - so a FOR SHARE/FOR UPDATE lock here
    // would not block a concurrent writer anyway (the row it would
    // insert doesn't exist yet to be locked), which is exactly why the
    // approved B2.3 instruction rules out relying on one. What running
    // this SELECT on `client` DOES guarantee: it detects any mismatch
    // that was already committed by another transaction at any point
    // up to and including the instant this statement runs within THIS
    // transaction - closing the gap between "resolved before the
    // transaction began" and "about to be written", which is strictly
    // tighter than the B2.2 version (whose separate connection gave no
    // such ordering guarantee relative to this transaction's own BEGIN
    // or its upcoment INSERTs). It does NOT guarantee no writer commits
    // between this SELECT and the subsequent INSERTs below - closing
    // that remaining window would require either advisory locks taken
    // by every writer (a cross-module change outside this batch's
    // scope - see B2.3's report) or SERIALIZABLE isolation with retry
    // handling (a larger change to withTransaction's contract, also
    // outside this batch). A mismatch found here is reported as
    // CONFLICT and the whole call rolls back - no manifest/snapshot is
    // ever written against a source package this call did not itself
    // verify, in this transaction, immediately before writing.
    for (const entityId of scopeEntityIds as string[]) {
      const recheck = await findCurrentEntityRevisionId(entityId, client);
      if (recheck !== entityRevisionIdByEntityId.get(entityId)) {
        throw new HttpError(
          "CONFLICT",
          `scope_entity_ids references ${entityId}, whose current revision changed ` +
            `while this snapshot was being prepared - retry the request`,
        );
      }
    }
    for (const dependency of referencedOnly) {
      const recheck = await findCurrentEntityRevisionId(dependency.entity_id, client);
      if (recheck !== dependency.entity_revision_id) {
        const viaTypes = dependency.supporting_paths.map((p) => p.relation_type).join(", ");
        throw new HttpError(
          "CONFLICT",
          `Dependency ${dependency.entity_id} (discovered via ${viaTypes}) ` +
            `had its current revision change while this snapshot was being prepared - retry the request`,
        );
      }
    }

    // B3.3 — comparison against expected_source_package, when provided.
    // The B2.3 re-checks above already confirm this call's own two
    // resolution passes (scope, then closure) still agree with each
    // other at this instant in this transaction. This comparison is
    // additionally against a THIRD, independent reference: whatever a
    // Working Preview resolved and showed the BA, potentially minutes
    // earlier and definitely via connections/transactions that have
    // long since closed. All four axes are compared; any mismatch is a
    // CONFLICT before any INSERT below runs.
    if (expectedSourcePackage) {
      // Axis 1 (entity revision) + Axis 4 (membership) for scope.
      const actualScopeById = new Map(
        (scopeEntityIds as string[]).map((id) => [
          id,
          { entity_revision_id: entityRevisionIdByEntityId.get(id)!, membership: confirmableEntityIds.has(id) ? "CONFIRMABLE" : "INCLUDED" } as const,
        ]),
      );
      if (actualScopeById.size !== expectedSourcePackage.scope.length) {
        throw new HttpError(
          "CONFLICT",
          `expected_source_package.scope has ${expectedSourcePackage.scope.length} entries but the current ` +
            `scope_entity_ids resolve to ${actualScopeById.size} - the selected scope itself has changed since the preview was built`,
        );
      }
      for (const expected of expectedSourcePackage.scope) {
        const actual = actualScopeById.get(expected.entity_id);
        if (!actual) {
          throw new HttpError(
            "CONFLICT",
            `expected_source_package.scope references ${expected.entity_id}, which is no longer part of scope_entity_ids`,
          );
        }
        if (actual.entity_revision_id !== expected.entity_revision_id) {
          throw new HttpError(
            "CONFLICT",
            `Scope entity ${expected.entity_id}'s current revision (${actual.entity_revision_id}) no longer ` +
              `matches the revision reviewed in the preview (${expected.entity_revision_id}) - retry the request`,
          );
        }
        if (actual.membership !== expected.membership) {
          throw new HttpError(
            "CONFLICT",
            `Scope entity ${expected.entity_id}'s membership (${actual.membership}) no longer matches the ` +
              `membership reviewed in the preview (${expected.membership}) - retry the request`,
          );
        }
      }

      // Axis 1 (entity revision) + Axis 3 (dependency path, as the SET
      // of (entity_id, relation_id) pairs) + Axis 2 (relation revision)
      // for referenced_only.
      const actualPathKeys = new Set<string>();
      const actualByEntityId = new Map(referencedOnly.map((d) => [d.entity_id, d]));
      for (const dep of referencedOnly) {
        for (const path of dep.supporting_paths) {
          actualPathKeys.add(`${dep.entity_id}::${path.relation_id}`);
        }
      }
      const expectedPathKeys = new Set<string>();
      for (const expected of expectedSourcePackage.referenced_only) {
        for (const path of expected.supporting_paths) {
          expectedPathKeys.add(`${expected.entity_id}::${path.relation_id}`);
        }
      }
      if (actualPathKeys.size !== expectedPathKeys.size || [...actualPathKeys].some((k) => !expectedPathKeys.has(k))) {
        throw new HttpError(
          "CONFLICT",
          "The set of dependency paths (entity + relation) has changed since the preview was built " +
            "(a dependency appeared, disappeared, or gained/lost a supporting relation) - retry the request",
        );
      }

      for (const expected of expectedSourcePackage.referenced_only) {
        const actual = actualByEntityId.get(expected.entity_id);
        if (!actual) {
          throw new HttpError(
            "CONFLICT",
            `expected_source_package.referenced_only references ${expected.entity_id}, which the freshly ` +
              `resolved dependency closure no longer includes - retry the request`,
          );
        }
        if (actual.entity_revision_id !== expected.entity_revision_id) {
          throw new HttpError(
            "CONFLICT",
            `Dependency ${expected.entity_id}'s current revision (${actual.entity_revision_id}) no longer ` +
              `matches the revision reviewed in the preview (${expected.entity_revision_id}) - retry the request`,
          );
        }
        const actualRelationRevisionsByRelationId = new Map(actual.supporting_paths.map((p) => [p.relation_id, p.relation_revision_id]));
        for (const expectedPath of expected.supporting_paths) {
          const actualRelationRevisionId = actualRelationRevisionsByRelationId.get(expectedPath.relation_id);
          if (actualRelationRevisionId !== expectedPath.relation_revision_id) {
            throw new HttpError(
              "CONFLICT",
              `Relation ${expectedPath.relation_id} (supporting dependency ${expected.entity_id}) has a different ` +
                `current revision than reviewed in the preview - retry the request`,
            );
          }
        }
      }
    }

    const manifest = await insertDraftManifest(client, {
      caseId: document.case_id,
      manifestPurpose: "DOCUMENT",
      createdBy: callerUserId,
    });

    let sortOrder = 1;
    for (const entityId of scopeEntityIds as string[]) {
      const entityRevisionId = entityRevisionIdByEntityId.get(entityId)!;
      await insertEntityRevisionManifestItem(client, {
        manifestId: manifest.manifest_id,
        entityRevisionId,
        sortOrder: sortOrder++,
        membershipRole: confirmableEntityIds.has(entityId) ? "CONFIRMABLE" : "INCLUDED",
      });
    }

    // Dependency closure items are pinned strictly as REFERENCED_ONLY
    // - never INCLUDED/CONFIRMABLE - per the approved contract's
    // Requirement #5 ("Không tự nâng REFERENCED_ONLY thành INCLUDED/
    // CONFIRMABLE"). They are appended after every scope item, so
    // sort_order reflects "selected scope first, then its resolved
    // dependencies", not an interleaving that could be mistaken for
    // scope ordering.
    //
    // item_notes (B2.3 CORRECTED): a stable, machine-parseable JSON
    // object - { kind: "REFERENCED_ONLY_PROVENANCE", supporting_paths: [...] }
    // - carrying EVERY supporting relation path dependency-closure.ts
    // found for this entity, not just one. The B2.2 version wrote a
    // free-text template string covering only a single path, which
    // both (a) could not be reliably parsed back out, and (b) lost
    // every additional path once dependency-closure.ts started
    // collecting more than one (see that module's B2.3 docblock).
    // Still stored in item_notes rather than a structured column
    // because manifest_items_check forbids a structured
    // relation_revision_id on an ENTITY_REVISION-kind row (see
    // insertEntityRevisionManifestItem's own comment on that
    // constraint) - this is a JSON string in a text column, not a new
    // schema capability.
    for (const dependency of referencedOnly) {
      await insertEntityRevisionManifestItem(client, {
        manifestId: manifest.manifest_id,
        entityRevisionId: dependency.entity_revision_id,
        sortOrder: sortOrder++,
        membershipRole: "REFERENCED_ONLY",
        itemNotes: JSON.stringify({
          kind: "REFERENCED_ONLY_PROVENANCE",
          supporting_paths: dependency.supporting_paths,
        }),
      });
    }

    // manifest_sha256 must fingerprint every revision this manifest
    // actually pins, not just the selected scope - otherwise two
    // manifests with the same scope but a different resolved closure
    // (e.g. a Rule's RULE_REFERENCES_DATA_DEFINITION link added between
    // two calls) would hash identically despite pinning different
    // content, defeating the point of a content-addressed manifest.
    const allPinnedRevisionIds = [
      ...entityRevisionIds,
      ...referencedOnly.map((d) => d.entity_revision_id),
    ];
    const sortedIds = [...allPinnedRevisionIds].sort();
    const manifestSha256 = createHash("sha256").update(sortedIds.join(",")).digest("hex");
    const frozen = await freezeManifest(client, {
      manifestId: manifest.manifest_id,
      manifestSha256,
    });
    if (!frozen) {
      throw new HttpError("INTERNAL_ERROR", "Failed to freeze the document's provenance manifest");
    }

    // content itself is persisted as the snapshot's own JSON payload -
    // storage_object_path is a logical identifier (no file/Storage
    // integration exists in this MVP slice), content_sha256 is the
    // server-computed fingerprint of the exact content stored, and
    // content_mime_type marks this as a structured Document Model, not
    // any rendered format.
    const snapshot = await repo.insertDocumentSnapshot(client, {
      documentId,
      manifestId: frozen.manifest_id,
      snapshotVersion: nextVersion,
      storageObjectPath: `document-model://${documentId}/v${nextVersion}`,
      contentSha256,
      contentMimeType: DOCUMENT_MODEL_MIME_TYPE,
      renderedBy: callerUserId,
    });

    await repo.insertSnapshotContent(client, {
      snapshotId: snapshot.snapshot_id,
      content: body.content,
    });

    return { manifest: frozen, snapshot };
  });

  return { data: result };
}

export async function getSnapshotService(snapshotId: string) {
  if (!isUuid(snapshotId)) {
    throw new HttpError("VALIDATION_ERROR", "snapshot_id must be a valid UUID");
  }
  const snapshot = await repo.findSnapshotById(snapshotId);
  if (!snapshot) {
    throw new HttpError("NOT_FOUND", `Document snapshot ${snapshotId} was not found`);
  }
  const content = await repo.findSnapshotContent(snapshotId);
  // Tells the caller exactly which manifest_item_id values a future
  // ConfirmationScopeItem may legally reference for this snapshot's
  // manifest - without this, a BA would have no way to discover a
  // valid manifest_item_id without querying the database directly.
  const confirmableManifestItems = await findConfirmableManifestItemsByManifestId(snapshot.manifest_id);
  return { data: { ...snapshot, content, confirmableManifestItems } };
}

export interface InvalidateSnapshotInput {
  reason?: unknown;
}

/**
 * Marks a snapshot INVALIDATED (the only mutation
 * rt_protect_document_snapshot permits) - used when later changes to
 * canonical source data mean a previously rendered snapshot no longer
 * reflects current business meaning (FR-029's "re-review required"
 * posture). The snapshot's content/hash/manifest are never touched;
 * only render_status changes.
 */
export async function invalidateSnapshotService(snapshotId: string, _body: InvalidateSnapshotInput) {
  if (!isUuid(snapshotId)) {
    throw new HttpError("VALIDATION_ERROR", "snapshot_id must be a valid UUID");
  }
  const existing = await repo.findSnapshotById(snapshotId);
  if (!existing) {
    throw new HttpError("NOT_FOUND", `Document snapshot ${snapshotId} was not found`);
  }
  if (existing.render_status !== "FROZEN") {
    throw new HttpError("VALIDATION_ERROR", "Only a FROZEN snapshot can be invalidated");
  }

  const result = await withTransaction((client) => repo.invalidateSnapshot(client, { snapshotId }));
  if (!result) {
    throw new HttpError("NOT_FOUND", `Document snapshot ${snapshotId} was not found`);
  }
  return { data: result };
}

const PUBLICATION_PURPOSES = ["CUSTOMER_REVIEW", "DEV_REVIEW", "HANDOFF"] as const;

export interface CreatePublicationInput {
  recipient_scope?: unknown;
  publication_purpose?: unknown;
  transmission_reference?: unknown;
}

/**
 * Publishes a FROZEN snapshot. rt_guard_document_publication is the
 * final authority (requires the snapshot AND its manifest to both be
 * FROZEN, and forces publication_status='PUBLISHED' on insert) - this
 * service pre-checks the same condition for a clearer error message,
 * never bypasses or weakens that trigger.
 */
export async function createPublicationService(
  snapshotId: string,
  body: CreatePublicationInput,
  callerUserId: string,
) {
  if (!isUuid(snapshotId)) {
    throw new HttpError("VALIDATION_ERROR", "snapshot_id must be a valid UUID");
  }
  const snapshot = await repo.findSnapshotById(snapshotId);
  if (!snapshot) {
    throw new HttpError("NOT_FOUND", `Document snapshot ${snapshotId} was not found`);
  }
  if (snapshot.render_status !== "FROZEN") {
    throw new HttpError(
      "VALIDATION_ERROR",
      "Only a FROZEN snapshot can be published - this one is INVALIDATED",
    );
  }
  if (
    typeof body.publication_purpose !== "string" ||
    !PUBLICATION_PURPOSES.includes(body.publication_purpose as (typeof PUBLICATION_PURPOSES)[number])
  ) {
    throw new HttpError(
      "VALIDATION_ERROR",
      `publication_purpose must be one of: ${PUBLICATION_PURPOSES.join(", ")}`,
    );
  }
  if (!isNonEmptyString(body.recipient_scope)) {
    throw new HttpError("VALIDATION_ERROR", "recipient_scope is required");
  }
  const transmissionReference =
    typeof body.transmission_reference === "string" ? body.transmission_reference : null;

  const nextVersion = (await repo.findMaxPublicationVersion(snapshot.document_id)) + 1;

  const result = await withTransaction((client) =>
    repo.insertPublication(client, {
      documentId: snapshot.document_id,
      snapshotId,
      publicationVersion: nextVersion,
      publicationPurpose: body.publication_purpose as string,
      recipientScope: body.recipient_scope as string,
      publishedBy: callerUserId,
      transmissionReference,
    }),
  );

  return { data: result };
}

export async function getPublicationService(publicationId: string) {
  if (!isUuid(publicationId)) {
    throw new HttpError("VALIDATION_ERROR", "publication_id must be a valid UUID");
  }
  const row = await repo.findPublicationById(publicationId);
  if (!row) {
    throw new HttpError("NOT_FOUND", `Document publication ${publicationId} was not found`);
  }
  // historical_confirmations_count distinguishes two separate facts
  // (per explicit instruction, never conflated): a CustomerConfirmation
  // row already recorded remains historically valid forever (INSERT-
  // only, never edited/deleted/reassigned to a different publication/
  // snapshot - see confirmations/service.ts) regardless of what this
  // publication's CURRENT status is. publication_status itself (not
  // altered here) tells the caller whether this publication is still
  // CURRENTLY APPLICABLE for creating a new confirmation or satisfying
  // a handoff precondition - PUBLISHED only; WITHDRAWN/SUPERSEDED
  // publications are rejected by createConfirmationService and
  // createHandoffService (both already required publication_status =
  // 'PUBLISHED' before this change). Neither fact is inferred from the
  // other.
  const historicalConfirmations = await findConfirmationsByPublicationId(publicationId);
  return { data: { ...row, historical_confirmations_count: historicalConfirmations.length } };
}

export interface UpdatePublicationStatusInput {
  publication_status?: unknown;
}

const PUBLICATION_TRANSITIONS: Record<string, string[]> = {
  PUBLISHED: ["WITHDRAWN", "SUPERSEDED"],
  WITHDRAWN: [],
  SUPERSEDED: [],
};

/**
 * Transitions a publication to WITHDRAWN/SUPERSEDED. Per explicit
 * instruction: this is ALWAYS allowed regardless of whether any
 * CustomerConfirmation already references this publication - a
 * Confirmation is INSERT-only, immutable history (confirmations/
 * service.ts never updates or deletes one), and this transition never
 * touches, reassigns, or invalidates any existing confirmation_id/
 * snapshot_id/manifest_id on an existing customer_confirmations row.
 * What DOES change is CURRENT applicability going forward: once
 * WITHDRAWN/SUPERSEDED, this publication can no longer be used to
 * create a NEW confirmation (createConfirmationService requires
 * publication_status = 'PUBLISHED') or satisfy a NEW handoff's
 * publication_ids (createHandoffService has the same requirement) -
 * both of those checks already existed before this change and are
 * unmodified here.
 *
 * The response surfaces whether historical confirmations exist
 * (`historical_confirmations_count`) purely as information for the
 * caller - it is never used to block the transition, and the caller
 * must not infer from a nonzero count that those confirmations are
 * now invalid; they remain exactly as historically valid as they were
 * when recorded, same as getPublicationService's own docblock states.
 */
export async function updatePublicationStatusService(
  publicationId: string,
  body: UpdatePublicationStatusInput,
) {
  if (!isUuid(publicationId)) {
    throw new HttpError("VALIDATION_ERROR", "publication_id must be a valid UUID");
  }
  if (
    typeof body.publication_status !== "string" ||
    !["WITHDRAWN", "SUPERSEDED"].includes(body.publication_status)
  ) {
    throw new HttpError("VALIDATION_ERROR", "publication_status must be one of: WITHDRAWN, SUPERSEDED");
  }

  const existing = await repo.findPublicationById(publicationId);
  if (!existing) {
    throw new HttpError("NOT_FOUND", `Document publication ${publicationId} was not found`);
  }
  const allowedNext = PUBLICATION_TRANSITIONS[existing.publication_status] ?? [];
  if (!allowedNext.includes(body.publication_status)) {
    throw new HttpError(
      "VALIDATION_ERROR",
      `Cannot transition publication from ${existing.publication_status} to ${body.publication_status}`,
    );
  }

  const historicalConfirmations = await findConfirmationsByPublicationId(publicationId);

  const result = await withTransaction((client) =>
    repo.updatePublicationStatus(client, {
      publicationId,
      publicationStatus: body.publication_status as "WITHDRAWN" | "SUPERSEDED",
    }),
  );
  if (!result) {
    throw new HttpError("NOT_FOUND", `Document publication ${publicationId} was not found`);
  }
  return {
    data: result,
    historical_confirmations_count: historicalConfirmations.length,
  };
}
