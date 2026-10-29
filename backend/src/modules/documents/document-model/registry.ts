// B3.2 — Section Registry: the one place that knows which of the 22
// QG-06 section codes belong to CRD vs DRD, and dispatches to each
// section's builder. No business logic lives here beyond that
// dispatch and classifying scope entities by type for the builders.

import { HttpError } from "../../../http/errors.js";
import type { DocumentModel, DocumentType, DocumentSection, SourceRef } from "./types.js";
import { findEntityType } from "../../traceability/repository.js";
import * as c from "./sections-c.js";
import * as d from "./sections-d.js";
import { DOCUMENT_MODEL_VERSION } from "./types.js";

const REQUIREMENT = "REQUIREMENT";
const BUSINESS_RULE = "BUSINESS_RULE";
const WORKFLOW_SCENARIO = "WORKFLOW_SCENARIO";

const CRD_SECTIONS = ["C01", "C02", "C03", "C04", "C05", "C06", "C07", "C08", "C09", "C10"] as const;
const DRD_SECTIONS = ["D01", "D02", "D03", "D04", "D05", "D06", "D07", "D08", "D09", "D10", "D11", "D12"] as const;

type SectionBuilder = (ctx: BuildContext) => Promise<DocumentSection>;

const C_BUILDERS: Record<(typeof CRD_SECTIONS)[number], SectionBuilder> = {
  C01: c.buildC01,
  C02: c.buildC02,
  C03: c.buildC03,
  C04: c.buildC04,
  C05: c.buildC05,
  C06: c.buildC06,
  C07: c.buildC07,
  C08: c.buildC08,
  C09: c.buildC09,
  C10: c.buildC10,
};

const D_BUILDERS: Record<(typeof DRD_SECTIONS)[number], SectionBuilder> = {
  D01: d.buildD01,
  D02: d.buildD02,
  D03: d.buildD03,
  D04: d.buildD04,
  D05: d.buildD05,
  D06: d.buildD06,
  D07: d.buildD07,
  D08: d.buildD08,
  D09: d.buildD09,
  D10: d.buildD10,
  D11: d.buildD11,
  D12: d.buildD12,
};

interface BuildContext {
  caseId: string;
  documentId: string | null;
  scopeEntityIds: readonly string[];
  requirementIds: readonly string[];
  ruleIds: readonly string[];
  workflowIds: readonly string[];
  sourceRefIndex: Map<string, SourceRef>;
}

/**
 * Builds a full DocumentModel for the given document_type, caseId, and
 * resolved source package (scope + closure, already turned into a
 * SourceRef index by source-refs.ts's buildSourceRefIndex). Classifies
 * every scope/closure entity by type once, up front, so every section
 * builder gets ready-made Requirement/Rule/Workflow id lists instead
 * of re-querying entity_identities per section.
 */
export async function buildDocumentModel(params: {
  documentType: DocumentType;
  caseId: string;
  documentId: string | null;
  scopeEntityIds: readonly string[];
  sourceRefIndex: Map<string, SourceRef>;
}): Promise<DocumentModel> {
  const allEntityIds = [...params.sourceRefIndex.keys()];
  const requirementIds: string[] = [];
  const ruleIds: string[] = [];
  const workflowIds: string[] = [];

  for (const entityId of allEntityIds) {
    const entityType = await findEntityType(entityId);
    if (entityType === REQUIREMENT) requirementIds.push(entityId);
    else if (entityType === BUSINESS_RULE) ruleIds.push(entityId);
    else if (entityType === WORKFLOW_SCENARIO) workflowIds.push(entityId);
  }

  const ctx: BuildContext = {
    caseId: params.caseId,
    documentId: params.documentId,
    scopeEntityIds: params.scopeEntityIds,
    requirementIds,
    ruleIds,
    workflowIds,
    sourceRefIndex: params.sourceRefIndex,
  };

  const codes: readonly string[] = params.documentType === "CRD" ? CRD_SECTIONS : DRD_SECTIONS;
  const builders: Record<string, SectionBuilder> = params.documentType === "CRD" ? C_BUILDERS : D_BUILDERS;

  const sections: DocumentSection[] = [];
  for (const code of codes) {
    const builder = builders[code];
    if (!builder) {
      throw new HttpError("INTERNAL_ERROR", `No section builder registered for ${code}`);
    }
    sections.push(await builder(ctx));
  }

  return {
    model_version: DOCUMENT_MODEL_VERSION,
    document_type: params.documentType,
    case_id: params.caseId,
    sections,
  };
}
