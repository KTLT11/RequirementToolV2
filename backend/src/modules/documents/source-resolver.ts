// B2.2 — Source Eligibility, Provenance & FC-09 Guidance.
//
// This is NOT a parallel Source Resolver - it is a read-only analysis
// layer built directly on top of what already exists: B2.1's
// resolveDependencyClosure() (dependency-closure.ts) for traversal,
// entities/service.ts's exact-revision access, and evidence/business-
// decisions' existing status columns for provenance. It computes and
// RETURNS findings; it never writes anything, never promotes a
// REFERENCED_ONLY dependency, and never calls createSnapshotService
// itself - a caller (createSnapshotService, a future Working Preview
// endpoint, or a BA-facing route) decides what to do with the result.
//
// Three distinct questions, per the approved B2.2 contract - never
// collapsed into one "is this usable" flag:
//
//   ACCESSIBLE - does this entity exist and resolve to a real current
//     revision? Answered from entity_identities + entity_revisions,
//     the same check createSnapshotService/resolveDependencyClosure
//     already perform before pinning anything. An entity that fails
//     this would already have failed the calling createSnapshotService
//     or resolveDependencyClosure call outright (both throw rather
//     than silently skip) - so by the time source-resolver.ts runs
//     on a closure's output, every entity in it is, by construction,
//     already known Accessible. This module still reports it
//     explicitly per-entity (rather than assuming it) so a finding
//     always carries its own basis, not an inherited assumption.
//
//   RELEVANT - does this entity's presence in the manifest trace back
//     to the BA's own selection or to one of the 4 approved typed
//     relations? Scope items are Relevant by definition (the BA chose
//     them). Closure items are Relevant because dependency-closure.ts
//     only ever adds an entity via one of its 4 approved relation
//     types (RULE_APPLIES_TO_REQUIREMENT, REQUIREMENT_FOLLOWS_WORKFLOW,
//     RULE_REFERENCES_DATA_DEFINITION, DECISION_SUPPORTS_RULE) - never
//     from shared case_id or any other inference. This module never
//     adds a new way for something to count as Relevant.
//
//   ELIGIBLE - is this entity's content actually fit to be used as a
//     confirmed/handoff-grade source right now? Per the approved
//     decision for this batch, there is NO policy in QG-06/Framework/
//     Quality Core today that defines this precisely (no CHECK_RULE
//     evaluates evidence_status/decision_outcome for this purpose,
//     and hardcoding e.g. "evidence_status must be CONFIRMED" would be
//     inventing a business policy this module has no authority to
//     invent). Eligibility is therefore ALWAYS reported as
//     "UNDETERMINED" with a reason and the specific information a BA
//     would need to provide/confirm before it could be decided -
//     never ELIGIBLE, never INELIGIBLE. This is a deliberate, approved
//     gap, not an oversight; see this module's docblock in B2.2's
//     final report for the standing blocker this leaves for B4/Quality
//     Core.
//
// FC-09 guidance (per the approved B2.2 contract) is returned as part
// of this module's own result - it is NOT written to validation_results
// (no CHECK_RULE/persistence contract exists for it yet) and does not
// reuse that table's shape beyond borrowing its spirit (deterministic
// finding vs. an unconfirmed candidate assessment).

import {
  resolveDependencyClosure,
  type ReferencedOnlyEntity,
  type SupportingPath,
} from "./dependency-closure.js";
import { findEntityType } from "../traceability/repository.js";
import { findCurrentEntityRevisionId } from "../validation/repository.js";
import { findEvidenceById } from "../evidence/repository.js";
import { findDecisionById } from "../business-decisions/repository.js";

export type AccessibilityStatus = "ACCESSIBLE" | "ERROR";
export type RelevanceStatus = "RELEVANT" | "NOT_APPLICABLE";
export type EligibilityStatus = "UNDETERMINED";

export type FindingIssueType =
  | "ELIGIBILITY_POLICY_UNDETERMINED"
  | "EVIDENCE_NOT_CONFIRMED"
  | "DECISION_NOT_AGREED"
  | "SOURCE_UNRESOLVABLE";

/**
 * One FC-09-shaped guidance entry: a deterministic fact about a
 * source item, paired with what a BA would need to do about it.
 * `is_candidate_suggestion` distinguishes a deterministic finding
 * (computed directly from recorded status columns - e.g. "evidence_
 * status is UNCONFIRMED") from a candidate suggestion this module
 * offers (e.g. "consider requesting confirmation") - per the approved
 * contract's instruction not to let a suggestion be mistaken for a
 * validated CHECK_RULE result.
 */
export interface SourceGuidance {
  issue_type: FindingIssueType;
  is_candidate_suggestion: boolean;
  affected_entity_id: string;
  affected_entity_type: string;
  affected_entity_revision_id: string | null;
  affected_section: string | null;
  evidence_basis: string;
  missing_information: string | null;
  impact: string;
  recommended_actions: string[];
  clarification_questions: string[];
  revalidation_guidance: string | null;
}

export interface SourceEligibilityFinding {
  entity_id: string;
  entity_type: string;
  entity_revision_id: string | null;
  accessibility: AccessibilityStatus;
  relevance: RelevanceStatus;
  eligibility: EligibilityStatus;
  eligibility_reason: string;
  // Empty for scope items (the BA's own selection, never a
  // dependency). Non-empty for entities discovered via dependency
  // closure - mirrors ReferencedOnlyEntity.supporting_paths exactly
  // (B2.3: every supporting relation path, not just one), so a caller
  // doesn't have to cross-reference resolveDependencyClosure's output
  // separately to explain "why is this here".
  supporting_paths: SupportingPath[];
  guidance: SourceGuidance[];
}

export interface SourcePackageResult {
  scope: SourceEligibilityFinding[];
  referenced_only: SourceEligibilityFinding[];
}

/**
 * Resolves the full source package for a selected document scope:
 * the scope itself plus its dependency closure (via
 * resolveDependencyClosure, not reimplemented here), each annotated
 * with Accessible/Relevant/Eligible status and FC-09 guidance.
 *
 * Read-only - performs no INSERT/UPDATE, and is safe to call before
 * createSnapshotService (to preview what a snapshot would pin and why)
 * or independently (e.g. a future Working Preview endpoint). Throws
 * the same HttpError resolveDependencyClosure/findCurrentEntityRevisionId
 * already throw for a genuinely unresolvable scope entity or
 * dependency - this module does not add new failure modes for the
 * traversal itself, only new analysis of what traversal already found.
 */
export async function resolveSourcePackage(
  scopeEntityIds: readonly string[],
): Promise<SourcePackageResult> {
  const referencedOnly = await resolveDependencyClosure(scopeEntityIds);

  const scope: SourceEligibilityFinding[] = [];
  for (const entityId of scopeEntityIds) {
    scope.push(await buildFinding(entityId, null));
  }

  const dependencies: SourceEligibilityFinding[] = [];
  for (const dependency of referencedOnly) {
    dependencies.push(await buildFinding(dependency.entity_id, dependency));
  }

  return { scope, referenced_only: dependencies };
}

async function buildFinding(
  entityId: string,
  discoveredAs: ReferencedOnlyEntity | null,
): Promise<SourceEligibilityFinding> {
  const entityType = await findEntityType(entityId);
  const entityRevisionId = entityType ? await findCurrentEntityRevisionId(entityId) : null;

  // Accessible: per this module's docblock, by the time this function
  // runs on a resolveDependencyClosure result (or on scope_entity_ids
  // that createSnapshotService's own earlier loop has already
  // validated), entityType/entityRevisionId should always resolve -
  // resolveDependencyClosure throws rather than returning an
  // unresolvable entity. A null result here therefore reflects a
  // caller using this function standalone, outside that guarantee
  // (e.g. a future route calling resolveSourcePackage directly without
  // createSnapshotService's own pre-validation) - reported as ERROR,
  // not silently treated as accessible.
  const accessibility: AccessibilityStatus = entityType && entityRevisionId ? "ACCESSIBLE" : "ERROR";

  // Relevant: scope items (discoveredAs === null) are Relevant by the
  // BA's own selection. Closure items are Relevant exactly because
  // dependency-closure.ts only ever produces them via one of its 4
  // approved relation types - never inferred here from case_id or
  // anything else.
  const relevance: RelevanceStatus = "RELEVANT";

  const { eligibility, eligibilityReason, guidance } = await assessEligibility(
    entityId,
    entityType,
    entityRevisionId,
    discoveredAs,
  );

  if (accessibility === "ERROR") {
    guidance.unshift({
      issue_type: "SOURCE_UNRESOLVABLE",
      is_candidate_suggestion: false,
      affected_entity_id: entityId,
      affected_entity_type: entityType ?? "UNKNOWN",
      affected_entity_revision_id: entityRevisionId,
      affected_section: null,
      evidence_basis: entityType
        ? `Entity ${entityId} (${entityType}) has no resolvable current revision.`
        : `Entity ${entityId} is not a registered entity.`,
      missing_information: "A valid, registered entity with at least one recorded revision.",
      impact: "This source cannot be pinned into any manifest or used by the Document Model.",
      recommended_actions: [
        "Verify the entity id is correct.",
        "If the entity should exist, confirm it was created through its owning module (not a dangling reference).",
      ],
      clarification_questions: [],
      revalidation_guidance: "Re-run source resolution after the entity is created or corrected.",
    });
  }

  return {
    entity_id: entityId,
    entity_type: entityType ?? "UNKNOWN",
    entity_revision_id: entityRevisionId,
    accessibility,
    relevance,
    eligibility,
    eligibility_reason: eligibilityReason,
    supporting_paths: discoveredAs?.supporting_paths ?? [],
    guidance,
  };
}

const EVIDENCE_TYPE = "EVIDENCE";
const BUSINESS_DECISION_TYPE = "BUSINESS_DECISION";

/**
 * Eligibility is always UNDETERMINED (per the approved B2.2 decision -
 * no hardcoded CONFIRMED/AGREED threshold, no invented policy). What
 * this function DOES do is surface the specific, already-recorded
 * status information a BA would need to look at to decide eligibility
 * themselves, as deterministic findings (not suggestions) when the
 * entity is Evidence or a Business Decision - the two entity types
 * this schema already tracks a confirmation-relevant status for. For
 * every other entity type, eligibility is UNDETERMINED with a generic
 * reason and no entity-type-specific guidance invented.
 */
async function assessEligibility(
  entityId: string,
  entityType: string | null,
  entityRevisionId: string | null,
  discoveredAs: ReferencedOnlyEntity | null,
): Promise<{
  eligibility: EligibilityStatus;
  eligibilityReason: string;
  guidance: SourceGuidance[];
}> {
  const guidance: SourceGuidance[] = [];

  if (entityType === EVIDENCE_TYPE) {
    const evidence = await findEvidenceById(entityId);
    if (evidence && evidence.evidence_status !== "CONFIRMED") {
      guidance.push({
        issue_type: "EVIDENCE_NOT_CONFIRMED",
        is_candidate_suggestion: false,
        affected_entity_id: entityId,
        affected_entity_type: EVIDENCE_TYPE,
        affected_entity_revision_id: entityRevisionId,
        affected_section: null,
        evidence_basis: `evidence.evidence_status = '${evidence.evidence_status}' (recorded fact, not an inference).`,
        missing_information:
          evidence.evidence_status === "UNCONFIRMED"
            ? "An authority-backed confirmation (POST /api/evidence/:id/confirmations with a valid authority_id)."
            : null,
        impact:
          "No approved policy in QG-06/Requirement Framework/Quality Core currently defines whether " +
          "this evidence_status is sufficient for this document's purpose - eligibility cannot be " +
          "determined by this module.",
        recommended_actions: [
          "BA to review this evidence's review/confirmation history before relying on it for a Customer-facing or Dev-facing document.",
        ],
        clarification_questions: [
          "Is this evidence's current status sufficient for the intended document's purpose, per BA/project policy?",
        ],
        revalidation_guidance:
          "Re-check this finding after evidence_status changes (e.g. after a confirmation is recorded).",
      });
    }
    return {
      eligibility: "UNDETERMINED",
      eligibilityReason:
        "No approved eligibility policy exists for Evidence sources in this codebase - " +
        "see the EVIDENCE_NOT_CONFIRMED finding (if present) for the recorded status a BA should review.",
      guidance,
    };
  }

  if (entityType === BUSINESS_DECISION_TYPE) {
    const decision = await findDecisionById(entityId);
    if (decision && decision.decision_outcome !== "AGREED") {
      guidance.push({
        issue_type: "DECISION_NOT_AGREED",
        is_candidate_suggestion: false,
        affected_entity_id: entityId,
        affected_entity_type: BUSINESS_DECISION_TYPE,
        affected_entity_revision_id: entityRevisionId,
        affected_section: null,
        evidence_basis: `business_decisions.decision_outcome = '${decision.decision_outcome}' (recorded fact, not an inference).`,
        missing_information:
          decision.decision_outcome === "PROPOSED"
            ? "A recorded resolution of this Decision (PATCH /api/decisions/:id with decision_outcome = AGREED or REJECTED)."
            : null,
        impact:
          "No approved policy in QG-06/Requirement Framework/Quality Core currently defines whether " +
          `a '${decision.decision_outcome}' Decision is sufficient as provenance for this document's ` +
          "purpose - eligibility cannot be determined by this module." +
          (discoveredAs && discoveredAs.supporting_paths.length > 0
            ? ` This Decision was pulled in as a dependency via ${discoveredAs.supporting_paths
                .map((p) => p.relation_type)
                .join(", ")}, not selected directly.`
            : ""),
        recommended_actions: [
          "BA to review this Decision's outcome before relying on any Rule/Requirement it supports for a Customer-facing or Dev-facing document.",
        ],
        clarification_questions: [
          "Is this Decision's current outcome sufficient for the intended document's purpose, per BA/project policy?",
        ],
        revalidation_guidance:
          "Re-check this finding after decision_outcome changes (e.g. after the Decision is AGREED or REJECTED).",
      });
    }
    return {
      eligibility: "UNDETERMINED",
      eligibilityReason:
        "No approved eligibility policy exists for Business Decision sources in this codebase - " +
        "see the DECISION_NOT_AGREED finding (if present) for the recorded outcome a BA should review.",
      guidance,
    };
  }

  return {
    eligibility: "UNDETERMINED",
    eligibilityReason:
      `No approved eligibility policy exists for ${entityType ?? "this"} sources in this codebase - ` +
      "this is a standing gap for B4/Quality Core, not a determination this module can make.",
    guidance,
  };
}
