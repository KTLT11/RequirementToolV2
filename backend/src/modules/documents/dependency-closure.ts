// B2.1/B2.3 — Dependency Closure & Exact Revision Pinning.
//
// Given a BA-selected document scope (the entity ids createSnapshotService
// already resolves to INCLUDED/CONFIRMABLE manifest items), this module
// finds every entity that scope's requirements/rules semantically depend
// on but that the BA did NOT select, so createSnapshotService can pin
// them into the same frozen manifest as REFERENCED_ONLY - "kept for
// context, not part of the confirmed/handoff scope" per the approved
// B1.2/B1.3 contract and TCR-10/E2.1 of QG-06 v1.3.
//
// Traverses exactly the 4 RELATION_TYPE definitions approved for this
// purpose (migration 022) - no other relation type participates, and
// no traversal is invented from two entities merely sharing a case_id
// (same-Case is not itself a dependency relationship; see B1.2's own
// decision not to add a same-Case constraint to these relation types).
//
//   RULE_APPLIES_TO_REQUIREMENT     source=BUSINESS_RULE   target=REQUIREMENT
//     A Rule applies TO a Requirement. A selected Requirement depends
//     on the Rules that apply to it, so traversal walks BACKWARD from
//     a Requirement to find Rules pointing at it (target match), never
//     forward from a Rule to "every Requirement it applies to" unless
//     that Rule is itself already in the closure.
//   REQUIREMENT_FOLLOWS_WORKFLOW    source=REQUIREMENT     target=WORKFLOW_SCENARIO
//     A Requirement depends on the Workflow it follows - traversal
//     walks FORWARD from a Requirement to the Workflow it points at.
//   RULE_REFERENCES_DATA_DEFINITION source=BUSINESS_RULE    target=BUSINESS_DATA_DEFINITION
//     A Rule depends on the Data Definition it references - traversal
//     walks FORWARD from a Rule (only once that Rule is already in the
//     closure, from the first relation type above) to the Data
//     Definition it points at.
//   DECISION_SUPPORTS_RULE          source=BUSINESS_DECISION target=BUSINESS_RULE
//     A Rule depends on the Decision that is its direct provenance -
//     traversal walks BACKWARD from a Rule (once in the closure) to
//     find Decisions pointing at it (target match), mirroring the
//     first relation type's direction for the same reason: the
//     dependent entity is the relation's target, so finding "what does
//     X depend on" from X means searching for relations where X is the
//     target and reading their source.
//
// This file's docblock direction descriptions are the ONLY approved
// traversal semantics (per the B2.1 instruction's own Requirement #2)
// - no other relation type, and no other direction for these 4, is
// inferred or added here.
//
// B2.3 CORRECTION: the B2.1 version stopped scanning a candidate
// relation as soon as it found that the relation's dependency entity
// was already `visited`, silently discarding every OTHER relation
// that also justified pulling that same entity in (e.g. two different
// selected Requirements both applying the same Rule via two separate
// RULE_APPLIES_TO_REQUIREMENT relation instances - only the first one
// BFS happened to see was recorded). This version still enqueues each
// entity for further traversal at most once (so the search space
// stays finite and duplicate-free - see `visited` below), but
// collects EVERY supporting relation path that points at a given
// dependency entity, not just the first, as `supporting_paths` on one
// ReferencedOnlyEntity per entity - never a second manifest item for
// the same entity (per the approved B2.3 instruction's "Giữ một
// manifest item cho mỗi entity dependency").

import { HttpError } from "../../http/errors.js";
import {
  findRelationsByEntityId,
  findEntityType,
  findCurrentRelationRevisionId,
} from "../traceability/repository.js";
import { findCurrentEntityRevisionId } from "../validation/repository.js";

const RULE_APPLIES_TO_REQUIREMENT = "RULE_APPLIES_TO_REQUIREMENT";
const REQUIREMENT_FOLLOWS_WORKFLOW = "REQUIREMENT_FOLLOWS_WORKFLOW";
const RULE_REFERENCES_DATA_DEFINITION = "RULE_REFERENCES_DATA_DEFINITION";
const DECISION_SUPPORTS_RULE = "DECISION_SUPPORTS_RULE";

const REQUIREMENT = "REQUIREMENT";
const BUSINESS_RULE = "BUSINESS_RULE";
const WORKFLOW_SCENARIO = "WORKFLOW_SCENARIO";
const BUSINESS_DATA_DEFINITION = "BUSINESS_DATA_DEFINITION";
const BUSINESS_DECISION = "BUSINESS_DECISION";

/**
 * One relation instance (at its current revision) that justifies a
 * dependency entity's presence in the closure. A single
 * ReferencedOnlyEntity can carry more than one of these - e.g. two
 * selected Requirements both applying the same Rule each contribute
 * their own RULE_APPLIES_TO_REQUIREMENT path to that Rule's
 * ReferencedOnlyEntity.
 */
export interface SupportingPath {
  relation_type: string;
  relation_id: string;
  relation_revision_id: string;
  from_entity_id: string;
}

export interface ReferencedOnlyEntity {
  entity_id: string;
  entity_type: string;
  entity_revision_id: string;
  // Every supporting relation path discovered for this entity (B2.3 -
  // not just the first one BFS happened to see). Always has at least
  // 1 element. Order is discovery order, not significant otherwise.
  supporting_paths: SupportingPath[];
}

/**
 * Computes the dependency closure for a selected document scope.
 *
 * `scopeEntityIds` is the BA's selected scope (already resolved by
 * the caller to INCLUDED/CONFIRMABLE manifest items) - this function
 * never mutates or reinterprets that set; it only ever returns
 * ADDITIONAL entities found outside it, each pinned to its CURRENT
 * entity_revisions row at the moment this function runs (same
 * resolution rule createSnapshotService already applies to the
 * selected scope itself - no separate "explicit revision" selector
 * exists anywhere in the current contract for scope_entity_ids
 * either, so there is nothing to preserve beyond "current revision,
 * resolved once, used consistently for the rest of this call").
 *
 * Traversal is breadth-first over a single `visited` set keyed by
 * entity_id, seeded with the scope itself so:
 *   - an entity already in scope is never re-added as REFERENCED_ONLY
 *     (the acceptance rule's "never promote/duplicate the selected
 *     scope"),
 *   - an entity reachable via two different paths (e.g. two selected
 *     Requirements sharing one Rule) is returned exactly once, as one
 *     ReferencedOnlyEntity whose supporting_paths records every path
 *     that reached it (B2.3 - see this file's docblock),
 *   - a cycle (which none of the 4 seeded relation types can form by
 *     direction alone, but a future relation type or malformed data
 *     could) cannot cause infinite traversal, since a visited
 *     entity_id is never re-enqueued for expansion (its incoming
 *     relations ARE still scanned for additional supporting_paths
 *     each time another already-queued entity's relations happen to
 *     point at it, but it itself contributes no new work to the
 *     queue once visited).
 *
 * Returns entities in first-discovery order (BFS), not sorted -
 * callers that need a stable sort order for manifest sort_order
 * should sort the result themselves (createSnapshotService does, by
 * appending after the already-sorted scope items).
 */
export async function resolveDependencyClosure(
  scopeEntityIds: readonly string[],
): Promise<ReferencedOnlyEntity[]> {
  const visited = new Set<string>(scopeEntityIds);
  const byEntityId = new Map<string, ReferencedOnlyEntity>();
  const order: string[] = [];

  // BFS queue of (entityId, entityType) pairs still to expand. Entity
  // type is looked up once per scope entity up front (not re-derived
  // later) since every entity this function discovers also needs its
  // type looked up before it can be enqueued - caching avoids a
  // redundant findEntityType call for the same id.
  const queue: Array<{ entityId: string; entityType: string }> = [];
  for (const entityId of scopeEntityIds) {
    const entityType = await findEntityType(entityId);
    // scope_entity_ids is already validated to be real, registered
    // entities by createSnapshotService before this function is ever
    // called, so this should never be null in practice - but per
    // Requirement #7 ("không âm thầm bỏ qua dependency bắt buộc"),
    // failing loudly here (rather than silently skipping the entity
    // from traversal) is correct defense-in-depth even if the caller
    // is expected to have already guaranteed it.
    if (!entityType) {
      throw new HttpError(
        "VALIDATION_ERROR",
        `Dependency closure could not resolve scope entity ${entityId} to a registered entity type`,
      );
    }
    queue.push({ entityId, entityType });
  }

  while (queue.length > 0) {
    const current = queue.shift()!;
    const relations = await findRelationsByEntityId(current.entityId);

    for (const relation of relations) {
      const match = matchDependency(current, relation);
      if (!match) continue;

      const alreadyVisited = visited.has(match.entityId);

      // Per Requirement #7 of the approved B2.1 contract ("không âm
      // thầm bỏ qua dependency bắt buộc"), a dependency that cannot be
      // fully resolved is a hard failure for this call, not a silent
      // omission - the entity_identities/entity_revisions pattern
      // guarantees every real entity has at least one revision
      // (registerEntity + createRevision always run in the same
      // transaction, with no DELETE grant anywhere in this schema), so
      // either of these cases means the relation data itself is
      // inconsistent (points at an id that was never registered, or at
      // one that is missing its mandatory first revision) - a genuine
      // data-integrity condition the caller must see, not paper over.
      // This check runs for every supporting path found, not just the
      // first, so a second path to an already-visited entity is held
      // to the same integrity standard as the first.
      const entityType = await findEntityType(match.entityId);
      if (!entityType) {
        throw new HttpError(
          "VALIDATION_ERROR",
          `Dependency closure found relation type ${match.relationTypeCode} pointing at ` +
            `${match.entityId}, which is not a registered entity`,
        );
      }

      const entityRevisionId = await findCurrentEntityRevisionId(match.entityId);
      if (!entityRevisionId) {
        throw new HttpError(
          "VALIDATION_ERROR",
          `Dependency closure found ${match.entityId} (via ${match.relationTypeCode}), ` +
            `which has no recorded revision`,
        );
      }

      // Provenance (B2.2/B2.3): the relation instance itself must also
      // resolve to a real relation_revisions row, same "fail loud, not
      // silent" posture as the entity side above - a relation row with
      // no revision would mean insertRelation()/insertRelationRevision()
      // were not called together, which never happens in this
      // codebase's write paths, but is still worth surfacing rather
      // than masking if it somehow did.
      const relationRevisionId = await findCurrentRelationRevisionId(match.relationId);
      if (!relationRevisionId) {
        throw new HttpError(
          "VALIDATION_ERROR",
          `Dependency closure found relation ${match.relationId} (${match.relationTypeCode}), ` +
            `which has no recorded relation revision`,
        );
      }

      const supportingPath: SupportingPath = {
        relation_type: match.relationTypeCode,
        relation_id: match.relationId,
        relation_revision_id: relationRevisionId,
        from_entity_id: current.entityId,
      };

      if (alreadyVisited) {
        // Not a new dependency entity - but still a genuine additional
        // reason this entity is in the closure (B2.3). If it is part
        // of the ORIGINAL selected scope rather than a previously
        // discovered dependency, there is no ReferencedOnlyEntity to
        // attach this path to (scope membership is INCLUDED/
        // CONFIRMABLE, not REFERENCED_ONLY, and is never altered by
        // this function - see this file's own docblock) - only record
        // the path when a ReferencedOnlyEntity already exists for it.
        const existing = byEntityId.get(match.entityId);
        if (existing) {
          existing.supporting_paths.push(supportingPath);
        }
        continue;
      }

      visited.add(match.entityId);
      const entry: ReferencedOnlyEntity = {
        entity_id: match.entityId,
        entity_type: entityType,
        entity_revision_id: entityRevisionId,
        supporting_paths: [supportingPath],
      };
      byEntityId.set(match.entityId, entry);
      order.push(match.entityId);
      queue.push({ entityId: match.entityId, entityType });
    }
  }

  return order.map((entityId) => byEntityId.get(entityId)!);
}

interface RelationLike {
  relation_id: string;
  relation_type_code: string;
  source_entity_id: string;
  target_entity_id: string;
}

/**
 * Applies the 4 approved traversal rules from this file's docblock to
 * one (current entity, candidate relation) pair. Returns the
 * dependency entity_id this relation reveals for `current`, or null
 * if the relation does not apply (wrong relation type for current's
 * entity_type/role, or current is on the wrong side of it).
 */
function matchDependency(
  current: { entityId: string; entityType: string },
  relation: RelationLike,
): { entityId: string; relationId: string; relationTypeCode: string } | null {
  switch (relation.relation_type_code) {
    case RULE_APPLIES_TO_REQUIREMENT:
      // source=BUSINESS_RULE, target=REQUIREMENT. A Requirement
      // depends on the Rule(s) that apply to it - current must be the
      // target (a Requirement), and the dependency is the source.
      if (current.entityType === REQUIREMENT && relation.target_entity_id === current.entityId) {
        return {
          entityId: relation.source_entity_id,
          relationId: relation.relation_id,
          relationTypeCode: relation.relation_type_code,
        };
      }
      return null;

    case REQUIREMENT_FOLLOWS_WORKFLOW:
      // source=REQUIREMENT, target=WORKFLOW_SCENARIO. A Requirement
      // depends on the Workflow it follows - current must be the
      // source (a Requirement), and the dependency is the target.
      if (current.entityType === REQUIREMENT && relation.source_entity_id === current.entityId) {
        return {
          entityId: relation.target_entity_id,
          relationId: relation.relation_id,
          relationTypeCode: relation.relation_type_code,
        };
      }
      return null;

    case RULE_REFERENCES_DATA_DEFINITION:
      // source=BUSINESS_RULE, target=BUSINESS_DATA_DEFINITION. A Rule
      // depends on the Data Definition it references - current must
      // be the source (a Rule), and the dependency is the target.
      if (current.entityType === BUSINESS_RULE && relation.source_entity_id === current.entityId) {
        return {
          entityId: relation.target_entity_id,
          relationId: relation.relation_id,
          relationTypeCode: relation.relation_type_code,
        };
      }
      return null;

    case DECISION_SUPPORTS_RULE:
      // source=BUSINESS_DECISION, target=BUSINESS_RULE. A Rule depends
      // on the Decision that supports it - current must be the target
      // (a Rule), and the dependency is the source.
      if (current.entityType === BUSINESS_RULE && relation.target_entity_id === current.entityId) {
        return {
          entityId: relation.source_entity_id,
          relationId: relation.relation_id,
          relationTypeCode: relation.relation_type_code,
        };
      }
      return null;

    default:
      // Any other relation type (DECOMPOSED_FROM, EVIDENCE_SUPPORTS_
      // DECISION, DECISION_SUPPORTS_REQUIREMENT, or anything seeded
      // later) deliberately does not participate in this closure, per
      // Requirement #3 of the B2.1 instruction - only the 4 relation
      // types named in the approved contract are traversed.
      return null;
  }
}

// Exported for tests only (entity_type constants mirrored from
// entity_identities.entity_type literals used across the codebase -
// see registerEntity() call sites).
export const DEPENDENCY_RELATION_TYPES = [
  RULE_APPLIES_TO_REQUIREMENT,
  REQUIREMENT_FOLLOWS_WORKFLOW,
  RULE_REFERENCES_DATA_DEFINITION,
  DECISION_SUPPORTS_RULE,
] as const;
