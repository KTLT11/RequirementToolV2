// B3.2 — CRD section builders (C01-C10), per QG-06 v1.3 Section C and
// B3.1's mapping contract. Each builder is read-only, composes already
// -resolved SourceRefs, and never invents a field QG-06 does not name
// for that section.

import type { DocumentSection, SectionField, SourceRef } from "./types.js";
import { always, workflowDependentApplicability, ruleDependentApplicability, noRepresentationApplicability } from "./applicability.js";
import { presentField, missingBusinessInfo, missingRepresentation, g1, g1Degraded, g2, buildRequirementBehaviorFields, buildAcReferencesField, buildRuleDetailFields, buildWorkflowStepsAndTransitions } from "./readers.js";
import { sourceRefsFor } from "./source-refs.js";
import { findDocumentById, findSnapshotsByDocumentId } from "../repository.js";
import { findConfirmationsByPublicationId, findScopeItemsByConfirmationId } from "../../confirmations/repository.js";
import { findPublicationsByDocumentId } from "../repository.js";
import { findContextsByCaseId } from "../../context/repository.js";
import { findScopeByCaseId } from "../../scope/repository.js";
import { findDecisionsByCaseId } from "../../business-decisions/repository.js";
import { findRequirementById } from "../../requirements/repository.js";
import { findAcByRequirementId } from "../../acceptance-criteria/repository.js";
import { findRuleById } from "../../business-rules/repository.js";
import { findRelationsByEntityId } from "../../traceability/repository.js";

interface SectionBuildContext {
  caseId: string;
  documentId: string | null;
  scopeEntityIds: readonly string[];
  requirementIds: readonly string[]; // scope entities whose entity_type is REQUIREMENT
  ruleIds: readonly string[]; // REFERENCED_ONLY or scope entities of type BUSINESS_RULE
  workflowIds: readonly string[]; // REFERENCED_ONLY or scope entities of type WORKFLOW_SCENARIO
  sourceRefIndex: Map<string, SourceRef>;
}

function section(code: string, title: string, applicability: { status: string; basis: string }, fields: SectionField[], sourceRefs: SourceRef[]): DocumentSection {
  return {
    section_code: code,
    section_title: title,
    applicability: applicability as DocumentSection["applicability"],
    fields,
    source_refs: sourceRefs,
  };
}

export async function buildC01(ctx: SectionBuildContext): Promise<DocumentSection> {
  const fields: SectionField[] = [];
  const document = ctx.documentId ? await findDocumentById(ctx.documentId) : null;

  fields.push(document ? presentField("documentId", "M", g1(document.document_id)) : missingBusinessInfo("documentId", "M"));

  if (document) {
    const snapshots = await findSnapshotsByDocumentId(document.document_id);
    const latest = snapshots.at(-1);
    fields.push(latest ? presentField("snapshotVersion", "M", g1(latest.snapshot_version)) : missingBusinessInfo("snapshotVersion", "M"));
  } else {
    fields.push(missingBusinessInfo("snapshotVersion", "M"));
  }

  fields.push(presentField("caseId", "M", g1(ctx.caseId)));
  fields.push(presentField("documentScope", "M", g1(ctx.scopeEntityIds)));

  // businessOwner - per B3.1 Open Decision #1, role_code mapping to
  // "business owner" is not confirmed; reported as a representation
  // gap rather than guessed.
  fields.push(missingRepresentation("businessOwner", "M", "No confirmed role_code maps to 'business owner' (B3.1 Open Decision #1) - not implemented"));

  // reviewStatus - per approved contract correction #5, Customer
  // Confirmation does not itself stand in for "Document Review
  // Status" without being read from the actual confirmation record
  // tied to THIS document's publications/snapshots - never defaulted
  // to Confirmed.
  if (document) {
    const publications = await findPublicationsByDocumentId(document.document_id);
    let anyConfirmed = false;
    let anyConfirmation = false;
    for (const pub of publications) {
      const confirmations = await findConfirmationsByPublicationId(pub.publication_id);
      if (confirmations.length > 0) anyConfirmation = true;
      if (confirmations.some((c) => c.confirmation_outcome === "CONFIRMED")) anyConfirmed = true;
    }
    fields.push(
      presentField(
        "reviewStatus",
        "M",
        g2(anyConfirmed ? "Confirmed" : anyConfirmation ? "Reviewed, not yet Confirmed" : "Pending"),
      ),
    );
  } else {
    fields.push(presentField("reviewStatus", "M", g1("Pending")));
  }

  fields.push(missingRepresentation("preparedBy", "C", "No column distinct from created_by/rendered_by is reserved for a human-facing 'prepared by' label - treated as unimplemented pending BA confirmation"));
  fields.push(document ? presentField("issueDate", "M", g1(document.created_at)) : missingBusinessInfo("issueDate", "M"));
  fields.push(missingRepresentation("projectName", "C", "No 'project_name' column exists anywhere in this schema (cases has no such field) - confirmed gap in B3.1"));

  return section("C01", "Document Overview", always(), fields, sourceRefsFor(ctx.sourceRefIndex, ctx.scopeEntityIds));
}

export async function buildC02(ctx: SectionBuildContext): Promise<DocumentSection> {
  const contexts = await findContextsByCaseId(ctx.caseId);
  const fields: SectionField[] = [];

  const problem = contexts.find((c) => c.context_type === "PROBLEM");
  const need = contexts.find((c) => c.context_type === "NEED");
  const objective = contexts.find((c) => c.context_type === "OBJECTIVE");

  fields.push(
    contexts.length > 0
      ? presentField("currentContext", "M", g1Degraded(contexts.map((c) => c.content), "business_contexts has no field separating current-state narrative from problem/need/objective beyond context_type classification"))
      : missingBusinessInfo("currentContext", "M"),
  );
  fields.push(problem ? presentField("businessProblem", "M", g1(problem.content)) : missingBusinessInfo("businessProblem", "M"));
  fields.push(need ? presentField("businessNeed", "M", g1(need.content)) : missingBusinessInfo("businessNeed", "M"));
  fields.push(objective ? presentField("businessObjectives", "M", g1(objective.content)) : missingBusinessInfo("businessObjectives", "M"));

  // expectedBenefits/successMeasures/currentPainPoints - no dedicated
  // context_type or column exists distinct from free-text content;
  // reported as representation gaps rather than guessed from PROBLEM/
  // NEED/OBJECTIVE rows.
  fields.push(missingRepresentation("expectedBenefits", "C", "business_contexts has no context_type/column distinct for expected benefits"));
  fields.push(missingRepresentation("successMeasures", "C", "business_contexts has no context_type/column distinct for success measures"));
  fields.push(missingRepresentation("currentPainPoints", "C", "business_contexts has no context_type/column distinct for pain points beyond PROBLEM"));

  return section("C02", "Business Background & Objectives", always(), fields, []);
}

export async function buildC03(ctx: SectionBuildContext): Promise<DocumentSection> {
  const scope = await findScopeByCaseId(ctx.caseId);
  const fields: SectionField[] = [];

  fields.push(scope ? presentField("inScope", "M", g1(scope.in_scope)) : missingBusinessInfo("inScope", "M"));
  fields.push(
    scope
      ? presentField("outOfScope", "M", g1(scope.out_of_scope ?? "(explicitly none recorded)"))
      : missingBusinessInfo("outOfScope", "M"),
  );
  fields.push(
    scope?.boundary_notes
      ? presentField("businessBoundaries", "C", g1(scope.boundary_notes))
      : missingBusinessInfo("businessBoundaries", "C"),
  );
  fields.push(
    scope?.constraints_json
      ? presentField("constraints", "C", g2(scope.constraints_json))
      : missingBusinessInfo("constraints", "C"),
  );

  // externalDependencies - per B3.1, this IS resolveDependencyClosure's
  // referenced_only output - the caller (registry.ts) is responsible
  // for passing the already-resolved REFERENCED_ONLY SourceRefs here;
  // this builder only renders their ids, it does not re-resolve.
  const referencedOnlyIds = [...ctx.sourceRefIndex.values()]
    .filter((r) => r.manifest_membership === "REFERENCED_ONLY")
    .map((r) => r.entity_id);
  fields.push(
    referencedOnlyIds.length > 0
      ? presentField("externalDependencies", "C", g2(referencedOnlyIds))
      : missingBusinessInfo("externalDependencies", "C"),
  );

  fields.push(missingRepresentation("assumptionsAffectingScope", "C", "No 'assumption' table/column exists distinct from case_scopes.boundary_notes free text"));

  return section(
    "C03",
    "Scope & Boundaries",
    always(),
    fields,
    sourceRefsFor(ctx.sourceRefIndex, referencedOnlyIds),
  );
}

export async function buildC04(_ctx: SectionBuildContext): Promise<DocumentSection> {
  const fields: SectionField[] = [
    missingRepresentation("businessOwner", "M", "No confirmed role_code maps to 'business owner' (B3.1 Open Decision #1)"),
    missingRepresentation("reviewApprover", "M", "No confirmed role_code maps to 'review approver' (B3.1 Open Decision #1)"),
    missingRepresentation("relevantRoles", "M", "Role listing requires a confirmed role_code vocabulary mapping not yet established"),
    missingRepresentation("responsibilityByRole", "M", "Same dependency as relevantRoles"),
    missingRepresentation("decisionAuthority", "C", "authority_assignments exists but evaluation-time semantics for this section are not yet decided (B3.1 Open Decision)"),
    missingRepresentation("processParticipant", "C", "Same dependency as relevantRoles"),
  ];
  return section("C04", "Stakeholders & Responsibilities", always(), fields, []);
}

export async function buildC05(ctx: SectionBuildContext): Promise<DocumentSection> {
  const decisions = await findDecisionsByCaseId(ctx.caseId);
  const fields: SectionField[] = [];

  fields.push(
    decisions.length > 0
      ? presentField("solutionSummary", "M", g1Degraded(decisions.map((d) => d.decision_text), "No 'capability' grouping exists - rendered as the raw list of recorded Business Decisions"))
      : missingBusinessInfo("solutionSummary", "M"),
  );
  fields.push(missingRepresentation("businessCapabilities", "C", "No 'capability' table/column exists anywhere in this schema (B3.1 confirmed gap)"));
  fields.push(missingRepresentation("proposedChanges", "C", "Depends on businessCapabilities grouping, which has no representation"));
  fields.push(missingRepresentation("outcomesPerCapability", "C", "Depends on businessCapabilities grouping, which has no representation"));
  fields.push(missingRepresentation("currentFutureComparison", "C", "No AS-IS/TO-BE structured representation exists"));
  fields.push(missingRepresentation("alternativeOptionsAndRationale", "C", "No structured alternatives/rationale representation beyond decision_text free text"));
  fields.push(missingBusinessInfo("solutionBoundaries", "C"));

  return section("C05", "Proposed Business Solution", always(), fields, []);
}

export async function buildC06(ctx: SectionBuildContext): Promise<DocumentSection> {
  const applicability = workflowDependentApplicability({
    hasLinkedWorkflow: ctx.workflowIds.length > 0,
    stepCount: null,
    qg06ConditionQuote:
      "Conditional khi có business process nhiều bước, approval, orchestration, nhiều actor, integration flow hoặc nhánh quan trọng",
  });

  if (applicability.status === "NOT_APPLICABLE") {
    return section("C06", "Business Workflow / Scenarios", applicability, [], []);
  }

  const fields: SectionField[] = [];
  const refs: SourceRef[] = [];
  for (const workflowId of ctx.workflowIds) {
    const { fields: wfFields } = await buildWorkflowStepsAndTransitions(workflowId);
    fields.push(...wfFields);
    const ref = ctx.sourceRefIndex.get(workflowId);
    if (ref) refs.push(ref);
  }

  // linkedReqRuleIds - via REQUIREMENT_FOLLOWS_WORKFLOW (reverse) for
  // each workflow in scope.
  const linkedReqIds: string[] = [];
  for (const workflowId of ctx.workflowIds) {
    const relations = await findRelationsByEntityId(workflowId);
    for (const r of relations) {
      if (r.relation_type_code === "REQUIREMENT_FOLLOWS_WORKFLOW" && r.target_entity_id === workflowId) {
        linkedReqIds.push(r.source_entity_id);
      }
    }
  }
  fields.push(linkedReqIds.length > 0 ? presentField("linkedReqRuleIds", "C", g2(linkedReqIds)) : missingBusinessInfo("linkedReqRuleIds", "C"));

  const applicableResult =
    applicability.status === "UNDETERMINED"
      ? applicability
      : { status: ctx.workflowIds.length > 0 ? "APPLICABLE" : "NOT_APPLICABLE", basis: applicability.basis };

  return section("C06", "Business Workflow / Scenarios", applicableResult as DocumentSection["applicability"], fields, refs);
}

export async function buildC07(ctx: SectionBuildContext): Promise<DocumentSection> {
  const fields: SectionField[] = [];
  const refs: SourceRef[] = [];

  for (const reqId of ctx.requirementIds) {
    const { fields: behaviorFields } = await buildRequirementBehaviorFields(reqId, false);
    fields.push(...behaviorFields);
    const acField = await buildAcReferencesField(reqId, "acReferences", "M");
    fields.push(acField);

    const relations = await findRelationsByEntityId(reqId);
    const ruleRefs = relations.filter((r) => r.relation_type_code === "RULE_APPLIES_TO_REQUIREMENT" && r.target_entity_id === reqId).map((r) => r.source_entity_id);
    fields.push(ruleRefs.length > 0 ? presentField("ruleReferences", "C", g2(ruleRefs)) : missingBusinessInfo("ruleReferences", "C"));
    const flowRefs = relations.filter((r) => r.relation_type_code === "REQUIREMENT_FOLLOWS_WORKFLOW" && r.source_entity_id === reqId).map((r) => r.target_entity_id);
    fields.push(flowRefs.length > 0 ? presentField("flowScenarioReferences", "C", g2(flowRefs)) : missingBusinessInfo("flowScenarioReferences", "C"));

    const ref = ctx.sourceRefIndex.get(reqId);
    if (ref) refs.push(ref);
  }

  // dependencyReferences - the REFERENCED_ONLY entities discovered for
  // this document's whole scope (not per-REQ attribution beyond what
  // supporting_paths.from_entity_id already encodes per entry).
  const referencedOnly = [...ctx.sourceRefIndex.values()].filter((r) => r.manifest_membership === "REFERENCED_ONLY");
  fields.push(referencedOnly.length > 0 ? presentField("dependencyReferences", "C", g2(referencedOnly.map((r) => r.entity_id))) : missingBusinessInfo("dependencyReferences", "C"));

  // Reporting Profile (TCR-01) - not implemented: B1.3's
  // structured_detail.reporting has only report_purpose/report_audience/
  // metrics/metric_definition/report_grain/filters/aggregation/
  // time_period/access_scope, missing several TCR-01-named fields
  // (sourceBusinessMeaning, display/exportExpectation) - reported
  // field-by-field where the backing data exists.
  for (const reqId of ctx.requirementIds) {
    const requirement = await findRequirementById(reqId);
    const reporting = (requirement?.structured_detail as { reporting?: Record<string, unknown> } | null | undefined)?.reporting;
    if (reporting) {
      fields.push(typeof reporting.report_purpose === "string" ? presentField("reportPurpose", "M", g1(reporting.report_purpose)) : missingBusinessInfo("reportPurpose", "M"));
      fields.push(typeof reporting.report_audience === "string" ? presentField("reportAudience", "M", g1(reporting.report_audience)) : missingBusinessInfo("reportAudience", "M"));
      fields.push(Array.isArray(reporting.metrics) ? presentField("metrics", "M", g1(reporting.metrics)) : missingBusinessInfo("metrics", "M"));
      fields.push(missingRepresentation("sourceBusinessMeaning", "C", "structured_detail.reporting has no 'sourceBusinessMeaning' field (B1.3 did not implement this TCR-01 field)"));
      fields.push(missingRepresentation("display/exportExpectation", "C", "structured_detail.reporting has no display/export field (B1.3 did not implement this TCR-01 field)"));
    }
  }

  return section("C07", "Detailed Business Requirements", always(), fields, refs);
}

export async function buildC08(ctx: SectionBuildContext): Promise<DocumentSection> {
  let sharedRuleCount = 0;
  let hasComplexKind = false;
  for (const ruleId of ctx.ruleIds) {
    const relations = await findRelationsByEntityId(ruleId);
    const applyingReqs = relations.filter((r) => r.relation_type_code === "RULE_APPLIES_TO_REQUIREMENT" && r.source_entity_id === ruleId);
    if (applyingReqs.length > 1) sharedRuleCount++;
    const rule = await findRuleById(ruleId);
    const kind = (rule?.rule_detail as { kind?: string } | null | undefined)?.kind;
    if (kind === "MULTI_CONDITION" || kind === "DECISION_TABLE") hasComplexKind = true;
  }

  const applicability = ruleDependentApplicability({
    hasAnyRule: ctx.ruleIds.length > 0,
    sharedRuleCount,
    hasStructuredComplexKind: hasComplexKind,
  });

  if (applicability.status === "NOT_APPLICABLE") {
    return section("C08", "Business Rules & Supporting Details", applicability, [], []);
  }

  const fields: SectionField[] = [];
  const refs: SourceRef[] = [];
  for (const ruleId of ctx.ruleIds) {
    fields.push(...(await buildRuleDetailFields(ruleId)));
    const relations = await findRelationsByEntityId(ruleId);
    const reqLinks = relations.filter((r) => r.relation_type_code === "RULE_APPLIES_TO_REQUIREMENT" && r.source_entity_id === ruleId).map((r) => r.target_entity_id);
    fields.push(reqLinks.length > 0 ? presentField("ruleReqLinks", "M", g2(reqLinks)) : missingBusinessInfo("ruleReqLinks", "M"));
    const dataRefs = relations.filter((r) => r.relation_type_code === "RULE_REFERENCES_DATA_DEFINITION" && r.source_entity_id === ruleId).map((r) => r.target_entity_id);
    fields.push(dataRefs.length > 0 ? presentField("sharedDataTerms", "C", g2(dataRefs)) : missingBusinessInfo("sharedDataTerms", "C"));
    const decisionRefs = relations.filter((r) => r.relation_type_code === "DECISION_SUPPORTS_RULE" && r.target_entity_id === ruleId).map((r) => r.source_entity_id);
    fields.push(decisionRefs.length > 0 ? presentField("decisionReference", "C", g2(decisionRefs)) : missingBusinessInfo("decisionReference", "C"));
    fields.push(missingRepresentation("businessPermissionSummary", "C", "No Permission representation exists in this schema (B3.1 confirmed gap)"));

    const ref = ctx.sourceRefIndex.get(ruleId);
    if (ref) refs.push(ref);
  }

  return section("C08", "Business Rules & Supporting Details", applicability as DocumentSection["applicability"], fields, refs);
}

export async function buildC09(ctx: SectionBuildContext): Promise<DocumentSection> {
  const fields: SectionField[] = [];
  const refs: SourceRef[] = [];

  for (const reqId of ctx.requirementIds) {
    const acs = await findAcByRequirementId(reqId);
    for (const ac of acs) {
      fields.push(presentField("acId", "M", g1(ac.ac_id)));
      fields.push(presentField("reqReference", "M", g1(reqId)));
      fields.push(presentField("acceptanceCondition", "M", g1(ac.condition_text)));
      fields.push(presentField("expectedResult", "M", g1(ac.expected_outcome)));
    }
    const ref = ctx.sourceRefIndex.get(reqId);
    if (ref) refs.push(ref);

    // customerFacingNfr - confirmed MISSING_REPRESENTATION (no NFR
    // table/column exists for a customer-facing-specific flag).
    const requirement = await findRequirementById(reqId);
    const nfr = (requirement?.structured_detail as { nfr?: Record<string, unknown> } | null | undefined)?.nfr;
    if (nfr) {
      fields.push(presentField("customerFacingNfr", "C", g2(nfr)));
    }
  }
  if (!fields.some((f) => f.field_name === "customerFacingNfr")) {
    fields.push(missingBusinessInfo("customerFacingNfr", "C"));
  }

  return section("C09", "Expected Outcomes & Acceptance Criteria", always(), fields, refs);
}

export async function buildC10(ctx: SectionBuildContext): Promise<DocumentSection> {
  const fields: SectionField[] = [];
  if (!ctx.documentId) {
    fields.push(missingBusinessInfo("documentId/version", "M"));
    return section("C10", "Customer Confirmation", always(), fields, []);
  }

  const publications = await findPublicationsByDocumentId(ctx.documentId);
  const allConfirmations = (
    await Promise.all(publications.map((p) => findConfirmationsByPublicationId(p.publication_id)))
  ).flat();
  const latest = allConfirmations.at(-1);

  fields.push(presentField("documentId/version", "M", g1(ctx.documentId)));
  fields.push(presentField("confirmationScope", "M", g1(ctx.scopeEntityIds)));

  if (latest) {
    fields.push(presentField("approverRole", "M", g1(latest.signer_authority_id)));
    fields.push(presentField("reviewOutcome", "M", g1(latest.confirmation_outcome)));
    fields.push(presentField("approverIdentity", "M", g1(latest.signer_stakeholder_id)));
    fields.push(presentField("date", "M", g1(latest.occurred_at)));
    fields.push(latest.comments ? presentField("comments", "C", g1(latest.comments)) : missingBusinessInfo("comments", "C"));
    const scopeItems = await findScopeItemsByConfirmationId(latest.confirmation_id);
    const changeRequests = scopeItems.filter((i) => i.unit_outcome !== "CONFIRMED");
    fields.push(
      changeRequests.length > 0
        ? presentField("changeRequests", "C", g2(changeRequests.map((i) => ({ manifest_item_id: i.manifest_item_id, unit_outcome: i.unit_outcome, note: i.note }))))
        : missingBusinessInfo("changeRequests", "C"),
    );
    fields.push(missingBusinessInfo("outstandingScope", "C"));
    fields.push(presentField("evidenceReference", "M", g1(latest.confirmation_basis)));
  } else {
    // Pending - per QG-06 C10's own rule, this is the correct, valid
    // state before any review has occurred, never an error.
    fields.push(presentField("reviewOutcome", "M", g1("Pending")));
    fields.push(missingBusinessInfo("approverRole", "M"));
    fields.push(missingBusinessInfo("approverIdentity", "M"));
    fields.push(missingBusinessInfo("date", "M"));
    fields.push(missingBusinessInfo("comments", "C"));
    fields.push(missingBusinessInfo("changeRequests", "C"));
    fields.push(missingBusinessInfo("outstandingScope", "C"));
    fields.push(missingBusinessInfo("evidenceReference", "M"));
  }

  return section("C10", "Customer Confirmation", always(), fields, []);
}
