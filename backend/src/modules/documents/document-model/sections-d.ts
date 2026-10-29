// B3.2 — DRD section builders (D01-D12), per QG-06 v1.3 Section D and
// B3.1's mapping contract.

import type { DocumentSection, SectionField, SourceRef } from "./types.js";
import { always, workflowDependentApplicability, ruleDependentApplicability, noRepresentationApplicability, profilePresenceApplicability } from "./applicability.js";
import { presentField, missingBusinessInfo, missingRepresentation, g1, g1Degraded, g2, buildRequirementBehaviorFields, buildAcReferencesField, buildRuleDetailFields, buildWorkflowStepsAndTransitions, buildQualityStatusField } from "./readers.js";
import { sourceRefsFor } from "./source-refs.js";
import { findDocumentById, findSnapshotsByDocumentId, findPublicationsByDocumentId } from "../repository.js";
import { findConfirmationsByPublicationId } from "../../confirmations/repository.js";
import { findScopeByCaseId } from "../../scope/repository.js";
import { findRequirementById, findRequirementsByCaseId } from "../../requirements/repository.js";
import { findAcByRequirementId } from "../../acceptance-criteria/repository.js";
import { findDataDefinitionsByCaseId, findAttributesByDataDefinitionId } from "../../data-definitions/repository.js";
import { findRelationsByEntityId } from "../../traceability/repository.js";
import { findHandoffsByCaseId, findDevReviewsByHandoffId } from "../../handoff/repository.js";
import { findAssessmentsByCaseId } from "../../assessment/repository.js";

interface SectionBuildContext {
  caseId: string;
  documentId: string | null;
  scopeEntityIds: readonly string[];
  requirementIds: readonly string[];
  ruleIds: readonly string[];
  workflowIds: readonly string[];
  sourceRefIndex: Map<string, SourceRef>;
}

function section(code: string, title: string, applicability: { status: string; basis: string }, fields: SectionField[], sourceRefs: SourceRef[]): DocumentSection {
  return { section_code: code, section_title: title, applicability: applicability as DocumentSection["applicability"], fields, source_refs: sourceRefs };
}

export async function buildD01(ctx: SectionBuildContext): Promise<DocumentSection> {
  const fields: SectionField[] = [];
  const document = ctx.documentId ? await findDocumentById(ctx.documentId) : null;

  fields.push(document ? presentField("documentId/version", "M", g1(document.document_id)) : missingBusinessInfo("documentId/version", "M"));
  fields.push(presentField("caseId/name", "M", g1(ctx.caseId)));
  fields.push(presentField("selectedReqIds/versions", "M", g1(ctx.requirementIds)));

  // documentStatus - this is `documents.document_status`, DELIBERATELY
  // not requirements.lifecycle_status (per approved contract correction
  // #5: "lifecycle_status không tự thay Quality Status"). documentStatus
  // describes the DOCUMENT's own lifecycle, not any one Requirement's.
  fields.push(document ? presentField("documentStatus", "M", g1(document.document_status)) : missingBusinessInfo("documentStatus", "M"));

  // customerConfirmedBaseline - per correction #5 ("Customer Confirmation
  // không tự thay Document Review Status"), this reads the actual
  // customer_confirmations record tied to this document's publications,
  // never inferred from requirements.lifecycle_status or defaulted true.
  if (document) {
    const publications = await findPublicationsByDocumentId(document.document_id);
    const allConfirmations = (await Promise.all(publications.map((p) => findConfirmationsByPublicationId(p.publication_id)))).flat();
    const confirmed = allConfirmations.some((c) => c.confirmation_outcome === "CONFIRMED");
    fields.push(presentField("customerConfirmedBaseline", "C", g1(confirmed)));
  } else {
    fields.push(missingBusinessInfo("customerConfirmedBaseline", "C"));
  }

  if (document) {
    const snapshots = await findSnapshotsByDocumentId(document.document_id);
    const latest = snapshots.at(-1);
    fields.push(latest ? presentField("snapshotId", "M", g1(latest.snapshot_id)) : missingBusinessInfo("snapshotId", "M"));
    fields.push(latest ? presentField("date/preparer", "M", g1(latest.rendered_at)) : missingBusinessInfo("date/preparer", "M"));
  } else {
    fields.push(missingBusinessInfo("snapshotId", "M"));
    fields.push(missingBusinessInfo("date/preparer", "M"));
  }
  fields.push(missingRepresentation("reviewer", "C", "No column distinct from rendered_by is reserved for a Dev reviewer identity at this stage"));

  return section("D01", "Document Overview & Baseline", always(), fields, sourceRefsFor(ctx.sourceRefIndex, ctx.scopeEntityIds));
}

export async function buildD02(ctx: SectionBuildContext): Promise<DocumentSection> {
  const scope = await findScopeByCaseId(ctx.caseId);
  const fields: SectionField[] = [];

  fields.push(scope ? presentField("purpose", "M", g1Degraded(scope.in_scope, "case_scopes has no field distinct from in_scope for a system-level 'purpose' statement")) : missingBusinessInfo("purpose", "M"));
  fields.push(missingRepresentation("systemResponsibility", "M", "No column distinct from in_scope/boundary_notes exists for system responsibility"));
  fields.push(scope ? presentField("in/outScope", "M", g1([scope.in_scope, scope.out_of_scope])) : missingBusinessInfo("in/outScope", "M"));
  fields.push(scope?.boundary_notes ? presentField("systemBoundary", "C", g1(scope.boundary_notes)) : missingBusinessInfo("systemBoundary", "C"));
  fields.push(missingRepresentation("involvedSystems", "C", "No Integration/system table exists in this schema (B3.1 confirmed gap)"));
  fields.push(scope?.constraints_json ? presentField("constraints/dependencies", "C", g2(scope.constraints_json)) : missingBusinessInfo("constraints/dependencies", "C"));

  const workflowRefs = ctx.workflowIds;
  fields.push(workflowRefs.length > 0 ? presentField("workflowReference", "C", g1(workflowRefs)) : missingBusinessInfo("workflowReference", "C"));

  return section("D02", "Solution Context & Scope", always(), fields, sourceRefsFor(ctx.sourceRefIndex, ctx.workflowIds));
}

export async function buildD03(ctx: SectionBuildContext): Promise<DocumentSection> {
  const fields: SectionField[] = [];
  const refs: SourceRef[] = [];

  for (const reqId of ctx.requirementIds) {
    const requirement = await findRequirementById(reqId);
    if (!requirement) continue;
    fields.push(presentField("reqId/title", "M", g1({ reqId, title: requirement.title })));
    fields.push(presentField("type/pattern", "M", g1(requirement.requirement_type)));

    const relations = await findRelationsByEntityId(reqId);
    const relatedReqIds = relations.filter((r) => r.relation_type_code === "DECOMPOSED_FROM").map((r) => (r.source_entity_id === reqId ? r.target_entity_id : r.source_entity_id));
    fields.push(relatedReqIds.length > 0 ? presentField("relatedReqIds", "C", g2(relatedReqIds)) : missingBusinessInfo("relatedReqIds", "C"));

    const sharedRuleRefs = relations.filter((r) => r.relation_type_code === "RULE_APPLIES_TO_REQUIREMENT" && r.target_entity_id === reqId).map((r) => r.source_entity_id);
    fields.push(sharedRuleRefs.length > 0 ? presentField("sharedRuleRefs", "C", g2(sharedRuleRefs)) : missingBusinessInfo("sharedRuleRefs", "C"));

    // dependencyRefs with "Referenced only" inclusion flag per TCR-10 -
    // directly reuses the REFERENCED_ONLY SourceRefs already resolved.
    const referencedOnly = [...ctx.sourceRefIndex.values()].filter((r) => r.manifest_membership === "REFERENCED_ONLY");
    fields.push(
      referencedOnly.length > 0
        ? presentField("dependencyRefs", "C", g2(referencedOnly.map((r) => ({ entity_id: r.entity_id, inclusion_flag: "Referenced only" }))))
        : missingBusinessInfo("dependencyRefs", "C"),
    );
    refs.push(...referencedOnly);

    // qualityStatus (B3.3 correction): requirements.lifecycle_status
    // is a BA workflow state (DRAFT/QUALITY_READY/STAKEHOLDER_CONFIRMED),
    // NOT a Quality Assessment outcome - the B3.2 mapping that read it
    // directly for this field was a mapping error, not a deliberate
    // degraded mode, and has been replaced with buildQualityStatusField,
    // which looks for an actual FINALIZED Quality assessment result
    // targeting this Requirement's CURRENT revision (freshness-checked)
    // and reports MISSING_REPRESENTATION with a specific reason
    // otherwise - never silently inferring Pass from lifecycle_status.
    fields.push(await buildQualityStatusField(ctx.caseId, reqId));
    fields.push(presentField("scope/version", "M", g1(requirement.current_revision_no)));

    const ref = ctx.sourceRefIndex.get(reqId);
    if (ref) refs.push(ref);
  }

  return section("D03", "Requirement & Dependency Map", always(), fields, refs);
}

export async function buildD04(ctx: SectionBuildContext): Promise<DocumentSection> {
  const fields: SectionField[] = [];
  const refs: SourceRef[] = [];

  for (const reqId of ctx.requirementIds) {
    const { fields: behaviorFields } = await buildRequirementBehaviorFields(reqId, true);
    fields.push(...behaviorFields);
    const acField = await buildAcReferencesField(reqId, "acRefs", "M");
    fields.push(acField);

    const relations = await findRelationsByEntityId(reqId);
    const ruleRefs = relations.filter((r) => r.relation_type_code === "RULE_APPLIES_TO_REQUIREMENT" && r.target_entity_id === reqId).map((r) => r.source_entity_id);
    fields.push(ruleRefs.length > 0 ? presentField("ruleRefs", "C", g2(ruleRefs)) : missingBusinessInfo("ruleRefs", "C"));
    fields.push(missingRepresentation("permissionRefs", "C", "No Permission representation exists in this schema"));
    fields.push(missingRepresentation("stateModelRef", "C", "workflow_transitions has no stateModelId/fromState/event/guardCondition/toState structure per TCR-03 (B1.3 confirmed gap)"));

    const ref = ctx.sourceRefIndex.get(reqId);
    if (ref) refs.push(ref);

    // Reporting technical profile (TCR-01) - same confirmed partial
    // coverage as C07's Reporting Profile.
    const requirement = await findRequirementById(reqId);
    const reporting = (requirement?.structured_detail as { reporting?: Record<string, unknown> } | null | undefined)?.reporting;
    if (reporting) {
      fields.push(typeof reporting.report_purpose === "string" ? presentField("purpose/audience", "M", g1(reporting.report_purpose)) : missingBusinessInfo("purpose/audience", "M"));
      fields.push(Array.isArray(reporting.metrics) ? presentField("metrics", "M", g1(reporting.metrics)) : missingBusinessInfo("metrics", "M"));
      fields.push(missingRepresentation("dataSources", "C", "structured_detail.reporting has no 'dataSources' field (B1.3 did not implement this TCR-01 field)"));
      fields.push(typeof reporting.report_grain === "string" ? presentField("grain", "C", g1(reporting.report_grain)) : missingBusinessInfo("grain", "C"));
    }
  }

  return section("D04", "Functional Requirement Specifications", always(), fields, refs);
}

export async function buildD05(ctx: SectionBuildContext): Promise<DocumentSection> {
  let sharedRuleCount = 0;
  let hasComplexKind = false;
  const { findRuleById } = await import("../../business-rules/repository.js");
  for (const ruleId of ctx.ruleIds) {
    const relations = await findRelationsByEntityId(ruleId);
    const applyingReqs = relations.filter((r) => r.relation_type_code === "RULE_APPLIES_TO_REQUIREMENT" && r.source_entity_id === ruleId);
    if (applyingReqs.length > 1) sharedRuleCount++;
    const rule = await findRuleById(ruleId);
    const kind = (rule?.rule_detail as { kind?: string } | null | undefined)?.kind;
    if (kind === "MULTI_CONDITION" || kind === "DECISION_TABLE") hasComplexKind = true;
  }

  const applicability = ruleDependentApplicability({ hasAnyRule: ctx.ruleIds.length > 0, sharedRuleCount, hasStructuredComplexKind: hasComplexKind });
  if (applicability.status === "NOT_APPLICABLE") {
    return section("D05", "Business Rules & Validation", applicability, [], []);
  }

  const fields: SectionField[] = [];
  const refs: SourceRef[] = [];
  for (const ruleId of ctx.ruleIds) {
    fields.push(...(await buildRuleDetailFields(ruleId)));
    const rule = await findRuleById(ruleId);
    const detail = rule?.rule_detail as { units?: unknown; rounding?: unknown } | null | undefined;
    fields.push(detail?.units !== undefined ? presentField("units/rounding", "C", g1([detail.units, detail?.rounding])) : missingBusinessInfo("units/rounding", "C"));

    const relations = await findRelationsByEntityId(ruleId);
    const relatedReqIds = relations.filter((r) => r.relation_type_code === "RULE_APPLIES_TO_REQUIREMENT" && r.source_entity_id === ruleId).map((r) => r.target_entity_id);
    fields.push(relatedReqIds.length > 0 ? presentField("relatedReqIds", "M", g2(relatedReqIds)) : missingBusinessInfo("relatedReqIds", "M"));
    const decisionRefs = relations.filter((r) => r.relation_type_code === "DECISION_SUPPORTS_RULE" && r.target_entity_id === ruleId).map((r) => r.source_entity_id);
    fields.push(decisionRefs.length > 0 ? presentField("decisionEvidenceRefs", "C", g2(decisionRefs)) : missingBusinessInfo("decisionEvidenceRefs", "C"));

    const ref = ctx.sourceRefIndex.get(ruleId);
    if (ref) refs.push(ref);
  }

  return section("D05", "Business Rules & Validation", applicability as DocumentSection["applicability"], fields, refs);
}

export async function buildD06(ctx: SectionBuildContext): Promise<DocumentSection> {
  const dataDefs = await findDataDefinitionsByCaseId(ctx.caseId);
  const applicability = dataDefs.length > 0 ? always() : noRepresentationApplicability("no Business Data Definition linked to this Case's selected scope");

  const fields: SectionField[] = [];
  const refs: SourceRef[] = [];
  for (const def of dataDefs) {
    fields.push(presentField("dataElementId/name", "M", g1({ id: def.data_definition_id, name: def.entity_name })));
    fields.push(presentField("businessMeaning", "M", g1(def.business_meaning)));
    fields.push(presentField("usage", "M", g1(def.data_kind)));

    const attributes = await findAttributesByDataDefinitionId(def.data_definition_id);
    for (const attr of attributes) {
      fields.push(presentField("type/format", "C", g1(attr.business_type)));
      fields.push(presentField("required/optional", "C", g1(attr.nullable_policy)));
      fields.push(attr.value_constraints ? presentField("allowedValues/statusDefinition", "C", g2(attr.value_constraints)) : missingBusinessInfo("allowedValues/statusDefinition", "C"));
    }

    // relatedReq/contractRefs - only reachable indirectly via
    // RULE_REFERENCES_DATA_DEFINITION (no direct Requirement->Data
    // relation is seeded - B1.2's deliberate decision, confirmed in
    // B3.1 Open Decision).
    const relations = await findRelationsByEntityId(def.data_definition_id);
    const ruleRefs = relations.filter((r) => r.relation_type_code === "RULE_REFERENCES_DATA_DEFINITION" && r.target_entity_id === def.data_definition_id).map((r) => r.source_entity_id);
    fields.push(
      ruleRefs.length > 0
        ? presentField("relatedReq/contractRefs", "M", g2(ruleRefs))
        : missingRepresentation("relatedReq/contractRefs", "M", "No direct Requirement->Data Definition relation is seeded (B1.2 decision) - only reachable via a Rule's RULE_REFERENCES_DATA_DEFINITION"),
    );

    const ref = ctx.sourceRefIndex.get(def.data_definition_id);
    if (ref) refs.push(ref);
  }

  return section("D06", "Data Specifications", applicability as DocumentSection["applicability"], fields, refs);
}

export async function buildD07(_ctx: SectionBuildContext): Promise<DocumentSection> {
  const applicability = noRepresentationApplicability("D07 requires a role->resource->action->decision policy matrix; authority_assignments is a time-boxed permission record, not this matrix (B3.1 confirmed gap)");
  const fields: SectionField[] = [
    missingRepresentation("role", "M", "No policy matrix representation exists"),
    missingRepresentation("resource", "M", "No policy matrix representation exists"),
    missingRepresentation("action", "M", "No policy matrix representation exists"),
    missingRepresentation("decision", "M", "No Allow/Deny/Conditional/N/A/Unresolved enum exists anywhere in this schema"),
  ];
  return section("D07", "Roles & Permissions", applicability, fields, []);
}

export async function buildD08(_ctx: SectionBuildContext): Promise<DocumentSection> {
  const applicability = noRepresentationApplicability("No Integration Contract/system table exists anywhere in this schema - per QG-06 B1 this may be intentionally an external artifact reference, not a DB table (B3.1 Open Decision)");
  const fields: SectionField[] = [
    missingRepresentation("integrationId", "M", "No Integration table exists"),
    missingRepresentation("sourceSystem", "M", "No Integration table exists"),
    missingRepresentation("targetSystem", "M", "No Integration table exists"),
  ];
  return section("D08", "Integration Specifications", applicability, fields, []);
}

export async function buildD09(ctx: SectionBuildContext): Promise<DocumentSection> {
  const applicability = workflowDependentApplicability({
    hasLinkedWorkflow: ctx.workflowIds.length > 0,
    stepCount: null,
    qg06ConditionQuote: "Conditional khi complex alternative/exception hoặc nhiều REQ chia sẻ behavior",
  });
  const fields: SectionField[] = [];
  if (applicability.status !== "NOT_APPLICABLE") {
    for (const workflowId of ctx.workflowIds) {
      const { fields: wfFields } = await buildWorkflowStepsAndTransitions(workflowId);
      // D09's TCR-03 state model fields are distinct from the plain
      // step/transition read - confirmed gap, not silently reused.
      fields.push(...wfFields.filter((f) => f.field_name !== "diagramReference"));
    }
    fields.push(missingRepresentation("stateModelId/version", "C", "workflow_transitions has no stateModelId/version/fromState/event/guardCondition/toState structure per TCR-03 (B1.3 confirmed gap)"));
  }
  return section("D09", "Alternative & Exception Flows", applicability as DocumentSection["applicability"], fields, sourceRefsFor(ctx.sourceRefIndex, ctx.workflowIds));
}

export async function buildD10(ctx: SectionBuildContext): Promise<DocumentSection> {
  let anyHasNfr = false;
  const fields: SectionField[] = [];
  const refs: SourceRef[] = [];

  for (const reqId of ctx.requirementIds) {
    const requirement = await findRequirementById(reqId);
    const nfr = (requirement?.structured_detail as { nfr?: Record<string, unknown> } | null | undefined)?.nfr;
    if (!nfr) continue;
    anyHasNfr = true;

    fields.push(presentField("nfrId", "M", g1(reqId)));
    fields.push(typeof nfr.quality_attribute === "string" ? presentField("qualityAttribute", "M", g1(nfr.quality_attribute)) : missingBusinessInfo("qualityAttribute", "M"));
    fields.push(typeof nfr.measurable_target === "string" ? presentField("measurableTarget", "M", g1(nfr.measurable_target)) : missingBusinessInfo("measurableTarget", "M"));
    fields.push(typeof nfr.measurement_condition === "string" ? presentField("measurementCondition", "M", g1(nfr.measurement_condition)) : missingBusinessInfo("measurementCondition", "M"));
    fields.push(typeof nfr.verification_method === "string" ? presentField("verificationMethod", "M", g1(nfr.verification_method)) : missingBusinessInfo("verificationMethod", "M"));

    const acField = await buildAcReferencesField(reqId, "relatedAcRefs", "M");
    fields.push(acField);

    // affectedScope - confirmed gap: B1.3 deliberately removed UUID
    // arrays from structured_detail, so NFR has no structured way to
    // reference which OTHER requirements it applies to.
    fields.push(missingRepresentation("affectedScope", "M", "structured_detail.nfr has no 'affected_scope' field - B1.3 deliberately removed UUID-array references from structured_detail (B3.1 Open Decision #6)"));

    const ref = ctx.sourceRefIndex.get(reqId);
    if (ref) refs.push(ref);
  }

  const applicability = profilePresenceApplicability({ profileName: "nfr", anyRequirementHasProfile: anyHasNfr });
  return section("D10", "Non-functional Requirements", applicability as DocumentSection["applicability"], fields, refs);
}

export async function buildD11(ctx: SectionBuildContext): Promise<DocumentSection> {
  const fields: SectionField[] = [];
  const refs: SourceRef[] = [];

  for (const reqId of ctx.requirementIds) {
    const acs = await findAcByRequirementId(reqId);
    for (const ac of acs) {
      fields.push(presentField("acId", "M", g1(ac.ac_id)));
      fields.push(presentField("reqId", "M", g1(reqId)));
      // Given/When/Then - acceptance_criteria has no 3 separate
      // columns; condition_text/expected_outcome are the closest
      // fields, rendered degraded rather than invented as 3 parts.
      fields.push(presentField("given/preconditions", "C", g1Degraded(null, "acceptance_criteria has no dedicated 'given/preconditions' column - condition_text is not split into Given/When/Then parts")));
      fields.push(presentField("when/trigger", "C", g1Degraded(ac.condition_text, "acceptance_criteria.condition_text is not split into Given/When/Then parts")));
      fields.push(presentField("then/expectedResult", "M", g1(ac.expected_outcome)));
      fields.push(ac.verification_method ? presentField("verificationEvidenceMethod", "C", g1(ac.verification_method)) : missingBusinessInfo("verificationEvidenceMethod", "C"));
      fields.push(presentField("acQualityStatus", "M", g1(ac.status)));
      fields.push(missingRepresentation("coverageLinks", "M", "No structural-coverage computation exists (behavior/rule/boundary/exception/permission/state -> AC) - this is Quality Core/B4 scope, not yet implemented"));
    }
    const ref = ctx.sourceRefIndex.get(reqId);
    if (ref) refs.push(ref);
  }

  return section("D11", "Acceptance Criteria & Verification", always(), fields, refs);
}

export async function buildD12(ctx: SectionBuildContext): Promise<DocumentSection> {
  const fields: SectionField[] = [];
  const handoffs = await findHandoffsByCaseId(ctx.caseId);
  const latest = handoffs.at(-1);

  if (!latest) {
    fields.push(presentField("reviewOutcome", "M", g1("Pending")));
    fields.push(missingBusinessInfo("snapshotId/version", "M"));
    fields.push(missingBusinessInfo("reviewScope", "M"));
    fields.push(missingBusinessInfo("reviewer", "M"));
    fields.push(missingBusinessInfo("layer3Readiness", "M"));
    return section("D12", "Dev Review & Handoff", always(), fields, []);
  }

  fields.push(presentField("snapshotId/version", "M", g1(latest.manifest_id)));
  fields.push(presentField("reviewScope", "M", g1(ctx.requirementIds)));

  const devReviews = await findDevReviewsByHandoffId(latest.handoff_id);
  const latestReview = devReviews.at(-1);
  if (latestReview) {
    fields.push(presentField("reviewer", "M", g1(latestReview.reviewer_stakeholder_id)));
    fields.push(presentField("reviewOutcome", "M", g1(latestReview.review_outcome)));
    fields.push(latestReview.review_comments ? presentField("comments", "C", g1(latestReview.review_comments)) : missingBusinessInfo("comments", "C"));
    fields.push(latestReview.review_evidence_ref ? presentField("evidence/date", "M", g1({ ref: latestReview.review_evidence_ref, date: latestReview.reviewed_at })) : missingBusinessInfo("evidence/date", "M"));
  } else {
    fields.push(presentField("reviewer", "M", g1("Pending")));
    fields.push(presentField("reviewOutcome", "M", g1("Pending")));
  }
  fields.push(missingBusinessInfo("blockers/acceptedRisks", "C"));

  const assessments = await findAssessmentsByCaseId(ctx.caseId, "READINESS");
  const readiness = assessments.find((a) => a.assessment_id === latest.readiness_assessment_id);
  fields.push(readiness ? presentField("layer3Readiness", "M", g1(readiness.outcome)) : missingBusinessInfo("layer3Readiness", "M"));

  return section("D12", "Dev Review & Handoff", always(), fields, []);
}
