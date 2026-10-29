// B3.2 — Shared G1/G2 readers, reused across multiple sections per
// the approved contract's "Tái sử dụng Requirement, Rule, Workflow,
// AC, NFR, Reporting và P3 readers" and B3.1's "Shared Composition
// Components" table. Every function here only reads already-existing
// repository rows and composes them - none writes, none invents a
// field QG-06 does not name, none infers business meaning beyond what
// the source row already states.

import type { FieldValue, SectionField, FieldStatus } from "./types.js";
import { findRequirementById } from "../../requirements/repository.js";
import { findAcByRequirementId } from "../../acceptance-criteria/repository.js";
import { findRuleById } from "../../business-rules/repository.js";
import { findWorkflowById, findStepsByWorkflowId, findTransitionsByWorkflowId } from "../../workflows/repository.js";
import { findLatestFinalizedAssessment } from "../../assessment/repository.js";
import { findEffectiveResultsByRunId } from "../../validation/repository.js";
import { findCurrentEntityRevisionId } from "../../validation/repository.js";

function presentField(fieldName: string, mandatory: "M" | "C", field: FieldValue): SectionField {
  return { field_name: fieldName, mandatory, field_status: "PRESENT", field, missing_representation_note: null };
}

function missingBusinessInfo(fieldName: string, mandatory: "M" | "C"): SectionField {
  return {
    field_name: fieldName,
    mandatory,
    field_status: "MISSING_BUSINESS_INFORMATION",
    field: null,
    missing_representation_note: null,
  };
}

function missingRepresentation(fieldName: string, mandatory: "M" | "C", note: string): SectionField {
  return {
    field_name: fieldName,
    mandatory,
    field_status: "MISSING_REPRESENTATION",
    field: null,
    missing_representation_note: note,
  };
}

function g1(value: unknown): FieldValue {
  return { value, generation_method: "G1", degraded: false, degraded_reason: null };
}

function g1Degraded(value: unknown, reason: string): FieldValue {
  return { value, generation_method: "G1", degraded: true, degraded_reason: reason };
}

function g2(value: unknown): FieldValue {
  return { value, generation_method: "G2", degraded: false, degraded_reason: null };
}

export { presentField, missingBusinessInfo, missingRepresentation, g1, g1Degraded, g2 };
export type { FieldStatus };

/**
 * Builds the M/C field slots QG-06 defines for a Requirement's
 * behavior (actor, trigger, preconditions, conditions, expected
 * outcome) - used by both C07 (Detailed Business Requirements) and
 * D04 (Functional Requirement Specifications). Per the approved
 * contract's correction #5 ("input không lấy từ preconditions"),
 * `input` is reported MISSING_REPRESENTATION, never silently filled
 * from `preconditions` - B1.3's structured_detail.functional schema
 * has no `input` field, and preconditions is a semantically distinct
 * concept (QG-06 D04 lists them as two separate fields).
 *
 * Falls back to `statement` (free text, degraded: true) for any field
 * when `structured_detail.functional` is absent or a specific field
 * within it is absent - per the approved contract's #6 ("Free-text
 * fallback giữ nguyên nội dung và gắn degraded status").
 */
export async function buildRequirementBehaviorFields(
  requirementId: string,
  includeInputField: boolean,
): Promise<{ fields: SectionField[]; requirement: Awaited<ReturnType<typeof findRequirementById>> }> {
  const requirement = await findRequirementById(requirementId);
  if (!requirement) {
    return { fields: [], requirement: null };
  }

  const structured = requirement.structured_detail as
    | { functional?: Record<string, unknown> }
    | null
    | undefined;
  const functional = structured?.functional;

  const fields: SectionField[] = [];

  fields.push(presentField("reqId", "M", g1(requirement.requirement_id)));
  fields.push(presentField("title", "M", g1(requirement.title)));
  fields.push(
    requirement.rationale
      ? presentField("businessPurpose", "M", g1(requirement.rationale))
      : missingBusinessInfo("businessPurpose", "M"),
  );

  // expectedBehavior/businessProcessing(behavior) - structured if
  // available, else the raw statement, explicitly flagged degraded.
  fields.push(presentField("expectedBehavior", "M", g1Degraded(requirement.statement, "requirements.structured_detail.functional is absent or incomplete - rendered from statement verbatim")));

  if (typeof functional?.actor === "string") {
    fields.push(presentField("relevantActor", "C", g1(functional.actor)));
  } else {
    fields.push(missingBusinessInfo("relevantActor", "C"));
  }

  if (typeof functional?.trigger === "string") {
    fields.push(presentField("trigger", "C", g1(functional.trigger)));
  } else {
    fields.push(missingBusinessInfo("trigger", "C"));
  }

  if (Array.isArray(functional?.preconditions)) {
    fields.push(presentField("preconditions", "C", g1(functional.preconditions)));
  } else {
    fields.push(missingBusinessInfo("preconditions", "C"));
  }

  if (Array.isArray(functional?.conditions)) {
    fields.push(presentField("conditions", "C", g1(functional.conditions)));
  } else {
    fields.push(missingBusinessInfo("conditions", "C"));
  }

  if (typeof functional?.expected_outcome === "string") {
    fields.push(presentField("expectedOutcome", "M", g1(functional.expected_outcome)));
  } else {
    fields.push(presentField("expectedOutcome", "M", g1Degraded(requirement.statement, "requirements.structured_detail.functional.expected_outcome is absent - rendered from statement verbatim")));
  }

  if (includeInputField) {
    // D04 names `input[C]` as its own field, distinct from
    // preconditions - B1.3's structured_detail.functional schema has
    // no `input` field, so this is a genuine representation gap, not
    // a value this function is allowed to derive from preconditions
    // (approved contract correction #5).
    fields.push(
      missingRepresentation(
        "input",
        "C",
        "requirements.structured_detail.functional has no 'input' field (distinct from preconditions per QG-06 D04) - not implemented in B1.3",
      ),
    );
  }

  return { fields, requirement };
}

/**
 * Builds the AC reference list for a Requirement - direct FK read
 * (acceptance_criteria.requirement_id), no closure/relation needed.
 * Used by C07/C09 (acReferences/customerFacingNfr context) and
 * D04/D11 (acRefs).
 */
export async function buildAcReferencesField(
  requirementId: string,
  fieldName: string,
  mandatory: "M" | "C",
): Promise<SectionField> {
  const acs = await findAcByRequirementId(requirementId);
  if (acs.length === 0) {
    return missingBusinessInfo(fieldName, mandatory);
  }
  return presentField(fieldName, mandatory, g1(acs.map((ac) => ac.ac_id)));
}

/**
 * Builds the Rule condition/outcome/formula fields QG-06 defines for
 * C08/D05 - structured via rule_detail when present (by `kind`),
 * degraded to rule_statement verbatim otherwise.
 */
export async function buildRuleDetailFields(ruleId: string): Promise<SectionField[]> {
  const rule = await findRuleById(ruleId);
  if (!rule) return [];

  const detail = rule.rule_detail as
    | { kind?: string; condition?: unknown; action_outcome?: unknown; values?: unknown; units?: unknown; rounding?: unknown; precedence?: unknown }
    | null
    | undefined;

  const fields: SectionField[] = [];
  fields.push(presentField("ruleId", "M", g1(rule.rule_id)));
  fields.push(presentField("ruleDefinition", "M", g1(rule.rule_statement)));

  if (typeof detail?.condition === "string") {
    fields.push(presentField("conditions", "M", g1(detail.condition)));
  } else {
    fields.push(presentField("conditions", "M", g1Degraded(rule.rule_statement, "business_rules.rule_detail is absent or has no 'condition' - rendered from rule_statement verbatim")));
  }

  if (detail?.action_outcome !== undefined) {
    fields.push(presentField("outcome", "M", g1(detail.action_outcome)));
  } else {
    fields.push(presentField("outcome", "M", g1Degraded(rule.rule_statement, "business_rules.rule_detail is absent or has no 'action_outcome' - rendered from rule_statement verbatim")));
  }

  if (detail?.values !== undefined || detail?.kind === "CALCULATION") {
    fields.push(
      detail?.values !== undefined
        ? presentField("values/formula", "C", g2(detail.values))
        : missingBusinessInfo("values/formula", "C"),
    );
  } else {
    fields.push(missingBusinessInfo("values/formula", "C"));
  }

  if (typeof detail?.precedence === "number") {
    fields.push(presentField("precedence", "C", g1(detail.precedence)));
  } else {
    fields.push(missingBusinessInfo("precedence", "C"));
  }

  return fields;
}

/**
 * Builds the Workflow step/transition table for C06/D09 - G2
 * composition joining workflow_steps + workflow_transitions by
 * workflow_id, both already FK-enforced to belong to the same
 * workflow (composite FK confirmed in workflows/service.ts).
 */
export async function buildWorkflowStepsAndTransitions(workflowId: string): Promise<{
  flow: Awaited<ReturnType<typeof findWorkflowById>>;
  fields: SectionField[];
}> {
  const flow = await findWorkflowById(workflowId);
  if (!flow) return { flow: null, fields: [] };

  const steps = await findStepsByWorkflowId(workflowId);
  const transitions = await findTransitionsByWorkflowId(workflowId);

  const fields: SectionField[] = [];
  fields.push(presentField("flowId", "M", g1(flow.workflow_id)));
  fields.push(presentField("startTrigger", "M", g1(flow.trigger_description ?? null)));
  fields.push(
    steps.length > 0
      ? presentField("steps", "M", g2(steps.map((s) => ({ step_id: s.step_id, step_name: s.step_name, step_type: s.step_type, actor_role_code: s.actor_role_code, sort_order: s.sort_order }))))
      : missingBusinessInfo("steps", "M"),
  );
  fields.push(
    steps.some((s) => s.actor_role_code)
      ? presentField("participantByStep", "C", g2(steps.map((s) => ({ step_id: s.step_id, actor_role_code: s.actor_role_code }))))
      : missingBusinessInfo("participantByStep", "C"),
  );
  fields.push(
    transitions.length > 0
      ? presentField(
          "nextStepPerBranch",
          "C",
          g2(
            transitions.map((t) => ({
              transition_id: t.transition_id,
              source_step_id: t.source_step_id,
              target_step_id: t.target_step_id,
              transition_condition: t.transition_condition,
              action_outcome: t.action_outcome,
            })),
          ),
        )
      : missingBusinessInfo("nextStepPerBranch", "C"),
  );
  const endStep = steps.find((s) => s.step_type === "END");
  fields.push(endStep ? presentField("endOutcome", "M", g1(endStep.step_name)) : missingBusinessInfo("endOutcome", "M"));

  // diagramReference - confirmed MISSING_REPRESENTATION in B3.1 (no
  // artifact/diagram table exists anywhere in this schema).
  fields.push(
    missingRepresentation(
      "diagramReference",
      "C",
      "No artifact/diagram table exists in this schema (confirmed in B0/B2.2 audits) - not implemented",
    ),
  );

  return { flow, fields };
}

/**
 * B3.3 correction (replaces the B3.2 mapping that read
 * requirements.lifecycle_status as D03's qualityStatus - lifecycle_
 * status is a BA workflow state, not a Quality Assessment outcome, and
 * conflating the two was a mapping error, not a deliberate degraded
 * mode).
 *
 * Finds the Case's latest FINALIZED Quality assessment
 * (assessment_records.assessment_type='QUALITY'), then looks inside
 * that assessment's own validation_run for an effective result
 * (findEffectiveResultsByRunId - already deduplicated per check/
 * target to the latest evaluation) whose target_entity_revision_id
 * matches the Requirement's CURRENT revision - not just its
 * requirement_id, so a result recorded against a now-superseded
 * revision is never silently reused (the "freshness" requirement).
 *
 * Reports the result only when both:
 *   1. a FINALIZED Quality assessment exists for this Case at all, and
 *   2. that assessment's run produced at least one effective result
 *      whose target_entity_revision_id equals this Requirement's
 *      CURRENT entity_revision_id (resolved fresh here, not cached).
 * Any other case (no assessment, assessment exists but no result
 * targets this requirement, or the only result found targets a
 * revision_id that is no longer current) is reported
 * MISSING_REPRESENTATION with an explanation distinguishing which of
 * these actually occurred - never silently treated as Pass.
 */
export async function buildQualityStatusField(caseId: string, requirementId: string): Promise<SectionField> {
  const assessment = await findLatestFinalizedAssessment(caseId, "QUALITY");
  if (!assessment) {
    return missingRepresentation(
      "qualityStatus",
      "M",
      "No FINALIZED Quality assessment exists for this Case - requirements.lifecycle_status is a BA workflow " +
        "state, not a Quality Assessment outcome, and is not used as a substitute",
    );
  }

  const currentRevisionId = await findCurrentEntityRevisionId(requirementId);
  if (!currentRevisionId) {
    return missingRepresentation("qualityStatus", "M", `Requirement ${requirementId} has no recorded current revision`);
  }

  const results = await findEffectiveResultsByRunId(assessment.validation_run_id ?? "");
  const matching = results.filter((r) => r.target_entity_revision_id === currentRevisionId);

  if (matching.length === 0) {
    return missingRepresentation(
      "qualityStatus",
      "M",
      `The Case's latest FINALIZED Quality assessment (${assessment.assessment_id}) produced no effective ` +
        `result targeting Requirement ${requirementId}'s current revision (${currentRevisionId}) - either no ` +
        `check evaluated this exact Requirement revision, or the assessment predates it (freshness check failed)`,
    );
  }

  return presentField(
    "qualityStatus",
    "M",
    g2({
      assessment_id: assessment.assessment_id,
      assessment_outcome: assessment.outcome,
      matched_requirement_revision_id: currentRevisionId,
      results: matching.map((r) => ({
        check_definition_version_id: r.check_definition_version_id,
        result_outcome: r.result_outcome,
        execution_status: r.execution_status,
        evaluated_at: r.evaluated_at,
      })),
    }),
  );
}
