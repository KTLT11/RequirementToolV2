// B1.1 — Exact Revision Read Access (CI-01 from the B0 audit).
//
// Internal lookup only, not yet wired to any public route: the
// authorization policy question (should this be Case-scoped?) is
// deliberately left open per the B0/B1.1 decision - the system has no
// Case-level access control anywhere today (every route checks only
// the single flat BA role; traceability's own findOwningCaseId exists
// but its result is discarded - see that module's docblock), so
// adding a Case check only here would invent a new policy rather than
// follow an existing one. A future caller (Document Source Resolver,
// AI Context Retrieval) that needs that policy decided should surface
// it as its own authorization layer, not bolt it onto this repository
// lookup. These functions stop at: does the revision exist, and does
// it actually belong to the entity/relation the caller named.
//
// Never falls back to the current/latest revision - a caller asking
// for revision 3 of an entity now on revision 7 gets revision 3's
// exact content_snapshot, or a clear error, never a silent substitute.

import { HttpError } from "../../http/errors.js";
import * as entityRepo from "./repository.js";
import * as relationRepo from "../traceability/repository.js";

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

export interface RevisionLookupInput {
  revision_id?: unknown;
  revision_no?: unknown;
}

type RevisionSelector = { kind: "id"; value: string } | { kind: "no"; value: number };

/**
 * Resolves exactly one of { revision_id, revision_no } from caller
 * input - the two are alternative ways to name the same exact
 * revision (opaque id vs. human-assigned sequence number), never
 * combined and never defaulted when both are absent. `idFieldLabel`
 * only changes the wording of validation errors, so entity callers
 * see "entity_revision_id" and relation callers see
 * "relation_revision_id" without duplicating this function.
 */
function parseRevisionSelector(input: RevisionLookupInput, idFieldLabel: string): RevisionSelector {
  const hasId = input.revision_id !== undefined && input.revision_id !== null;
  const hasNo = input.revision_no !== undefined && input.revision_no !== null;

  if (hasId && hasNo) {
    throw new HttpError(
      "VALIDATION_ERROR",
      `Provide exactly one of ${idFieldLabel} or revision_no, not both`,
    );
  }
  if (hasId) {
    if (typeof input.revision_id !== "string" || !isUuid(input.revision_id)) {
      throw new HttpError("VALIDATION_ERROR", `${idFieldLabel} must be a valid UUID`);
    }
    return { kind: "id", value: input.revision_id };
  }
  if (hasNo) {
    if (!isPositiveInteger(input.revision_no)) {
      throw new HttpError("VALIDATION_ERROR", "revision_no must be a positive integer");
    }
    return { kind: "no", value: input.revision_no };
  }
  throw new HttpError("VALIDATION_ERROR", `Provide exactly one of ${idFieldLabel} or revision_no`);
}

/**
 * Returns the exact historical content_snapshot + revision metadata +
 * entity identity for one entity revision.
 *
 * Error shape (per CI-01 requirement #6 - Not Found vs data integrity
 * distinguished; nothing here is a FORBIDDEN case since no Case policy
 * is enforced at this layer - see module docblock):
 *   - entityId not registered at all                  -> NOT_FOUND
 *   - revision selector matches no row anywhere        -> NOT_FOUND
 *   - revision selector matches a row, but it belongs
 *     to a different entity_id than the one requested  -> CONFLICT
 *     (the revision is real, just not this entity's - a genuine
 *     disagreement between the two identifiers the caller supplied,
 *     not a plain 404; this codebase has no separate
 *     DATA_INTEGRITY_ERROR code, and inventing one is out of scope
 *     for B1.1, so CONFLICT is the closest existing fit)
 */
export async function getEntityRevisionService(entityId: string, input: RevisionLookupInput) {
  if (!isUuid(entityId)) {
    throw new HttpError("VALIDATION_ERROR", "entity_id must be a valid UUID");
  }
  const selector = parseRevisionSelector(input, "entity_revision_id");

  const exists = await entityRepo.entityExists(entityId);
  if (!exists) {
    throw new HttpError("NOT_FOUND", `Entity ${entityId} was not found`);
  }

  const revision =
    selector.kind === "id"
      ? await entityRepo.findRevisionById(entityId, selector.value)
      : await entityRepo.findRevisionByNo(entityId, selector.value);

  if (!revision) {
    if (selector.kind === "id") {
      // Classification only - never returns the other entity's
      // content, only whether the id exists at all somewhere.
      const existsElsewhere = await entityRepo.revisionIdExistsForAnyEntity(selector.value);
      if (existsElsewhere) {
        throw new HttpError(
          "CONFLICT",
          `Revision ${selector.value} exists but does not belong to entity ${entityId}`,
        );
      }
    }
    throw new HttpError(
      "NOT_FOUND",
      selector.kind === "id"
        ? `Revision ${selector.value} was not found for entity ${entityId}`
        : `Revision number ${selector.value} was not found for entity ${entityId}`,
    );
  }

  return { data: revision };
}

/**
 * Same exact-revision guarantee as getEntityRevisionService, for a
 * relation's own relation_revisions history instead.
 */
export async function getRelationRevisionService(relationId: string, input: RevisionLookupInput) {
  if (!isUuid(relationId)) {
    throw new HttpError("VALIDATION_ERROR", "relation_id must be a valid UUID");
  }
  const selector = parseRevisionSelector(input, "relation_revision_id");

  const exists = await relationRepo.relationExists(relationId);
  if (!exists) {
    throw new HttpError("NOT_FOUND", `Relation ${relationId} was not found`);
  }

  const revision =
    selector.kind === "id"
      ? await relationRepo.findRelationRevisionById(relationId, selector.value)
      : await relationRepo.findRelationRevisionByNo(relationId, selector.value);

  if (!revision) {
    if (selector.kind === "id") {
      const existsElsewhere = await relationRepo.relationRevisionIdExistsForAnyRelation(
        selector.value,
      );
      if (existsElsewhere) {
        throw new HttpError(
          "CONFLICT",
          `Revision ${selector.value} exists but does not belong to relation ${relationId}`,
        );
      }
    }
    throw new HttpError(
      "NOT_FOUND",
      selector.kind === "id"
        ? `Revision ${selector.value} was not found for relation ${relationId}`
        : `Revision number ${selector.value} was not found for relation ${relationId}`,
    );
  }

  return { data: revision };
}
