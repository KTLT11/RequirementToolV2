// B3.2 — Section applicability evaluation.
//
// Per the approved contract (#2/#3): applicability is evaluated
// against QG-06's own stated condition for each conditional section,
// never invented. Where QG-06's condition itself is qualitative and
// not objectively decidable from recorded data alone (e.g. C06's
// "nhiều bước, approval, orchestration, nhiều actor... hoặc nhánh
// quan trọng" - none of which names a numeric threshold), this module
// does NOT substitute a numeric proxy (e.g. "more than N steps") as
// if it were QG-06's rule - that would be inventing a threshold QG-06
// never specified, which is exactly what #3 forbids. Instead it
// reports UNDETERMINED with a basis that states plainly what IS known
// (e.g. "workflow has N steps") and what QG-06 does not resolve for
// that case (the qualitative threshold), leaving the actual
// determination to the BA.
//
// Three outcomes only, each requiring a stated basis - see types.ts's
// SectionApplicability docblock for why "absence of source" alone is
// never grounds for NOT_APPLICABLE.

import type { ApplicabilityStatus } from "./types.js";

export interface ApplicabilityResult {
  status: ApplicabilityStatus;
  basis: string;
}

export function always(): ApplicabilityResult {
  return { status: "APPLICABLE", basis: "QG-06: section applicability is \"Always\"." };
}

/**
 * C06 / D09-style "conditional on process complexity" sections. QG-06
 * does not define a numeric threshold for "nhiều bước" or "complex
 * alternative/exception" - only presence/absence of a linked Workflow
 * at all is objectively decidable from recorded data. When a Workflow
 * exists, this function does NOT attempt to judge whether it is
 * "complex enough" (that would invent a threshold QG-06 never gave) -
 * it reports UNDETERMINED, stating the known fact (step count) without
 * treating it as the deciding criterion.
 */
export function workflowDependentApplicability(params: {
  hasLinkedWorkflow: boolean;
  stepCount: number | null;
  qg06ConditionQuote: string;
}): ApplicabilityResult {
  if (!params.hasLinkedWorkflow) {
    return {
      status: "NOT_APPLICABLE",
      basis:
        `No Workflow Scenario is linked to any selected Requirement (via REQUIREMENT_FOLLOWS_WORKFLOW). ` +
        `QG-06 condition: "${params.qg06ConditionQuote}" - with no workflow present at all, this section has no basis to apply.`,
    };
  }
  return {
    status: "UNDETERMINED",
    basis:
      `A linked Workflow Scenario exists (${params.stepCount ?? "unknown"} recorded step(s)). ` +
      `QG-06 condition: "${params.qg06ConditionQuote}" - this is a qualitative judgment ` +
      `(no numeric threshold is defined by QG-06), so step count alone is not treated as sufficient ` +
      `evidence for APPLICABLE or NOT_APPLICABLE per the approved B3.2 contract (#3). BA review needed.`,
  };
}

/**
 * C08 / D05-style "conditional on rule being shared/complex" sections.
 * Same reasoning as workflowDependentApplicability: QG-06 names
 * "shared" (objectively decidable - more than one Requirement applies
 * the rule) and "complex" (not objectively decidable from a count
 * alone) as alternative triggers. "Shared" can be determined
 * factually from relation count; "complex" cannot be reduced to a
 * threshold this module invents.
 */
export function ruleDependentApplicability(params: {
  hasAnyRule: boolean;
  sharedRuleCount: number; // number of rules with >1 RULE_APPLIES_TO_REQUIREMENT relation
  hasStructuredComplexKind: boolean; // rule_detail.kind in (MULTI_CONDITION, DECISION_TABLE) for any rule in scope
}): ApplicabilityResult {
  if (!params.hasAnyRule) {
    return {
      status: "NOT_APPLICABLE",
      basis: "No Business Rule is linked to any selected Requirement (via RULE_APPLIES_TO_REQUIREMENT).",
    };
  }
  if (params.sharedRuleCount > 0) {
    return {
      status: "APPLICABLE",
      basis: `${params.sharedRuleCount} rule(s) in scope are applied by more than one Requirement (QG-06: "rule shared" - objectively decidable from relation count).`,
    };
  }
  if (params.hasStructuredComplexKind) {
    return {
      status: "APPLICABLE",
      basis:
        "At least one rule in scope has a structured rule_detail.kind of MULTI_CONDITION or DECISION_TABLE " +
        "(QG-06: \"rule... complex\" - decidable from the BA's own structured classification, not an invented threshold).",
    };
  }
  return {
    status: "UNDETERMINED",
    basis:
      "Rule(s) are linked but none is shared across Requirements and none has a structured rule_detail " +
      "classifying it as complex. QG-06's \"rule shared/complex\" condition cannot be conclusively " +
      "evaluated from available structured data alone - a rule may still be complex in free-text form " +
      "without rule_detail recorded. BA review needed.",
  };
}

/**
 * Sections conditional on a canonical representation that simply does
 * not exist anywhere in this schema (D07 Permission, D08 Integration,
 * C09/D10 NFR when none is present, etc.) - per the approved contract,
 * absence of a source/table is never itself proof of NOT_APPLICABLE
 * (the Case might genuinely need this and the schema just can't
 * record it yet). Always UNDETERMINED with the specific gap named.
 */
export function noRepresentationApplicability(missingRepresentationNote: string): ApplicabilityResult {
  return {
    status: "UNDETERMINED",
    basis:
      `No canonical representation exists in this schema to determine this section's applicability ` +
      `(${missingRepresentationNote}). This does not mean the section is not applicable - only that ` +
      `this tool cannot currently determine it from recorded data. BA review needed.`,
  };
}

/**
 * Sections conditional on whether any Requirement in scope carries a
 * given structured_detail profile (nfr/reporting) - objectively
 * decidable: either at least one Requirement has that profile key
 * present, or none does.
 */
export function profilePresenceApplicability(params: {
  profileName: "nfr" | "reporting";
  anyRequirementHasProfile: boolean;
}): ApplicabilityResult {
  if (params.anyRequirementHasProfile) {
    return {
      status: "APPLICABLE",
      basis: `At least one selected Requirement carries a structured_detail.${params.profileName} profile.`,
    };
  }
  return {
    status: "UNDETERMINED",
    basis:
      `No selected Requirement carries a structured_detail.${params.profileName} profile. This may mean ` +
      `none applies, or that the BA has not yet recorded it in structured form (free-text statement/rationale ` +
      `could still contain ${params.profileName}-relevant content not captured here) - not treated as a ` +
      `confirmed NOT_APPLICABLE per the approved contract.`,
  };
}
