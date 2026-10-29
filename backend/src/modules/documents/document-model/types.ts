// B3.2 — Versioned Document Model, shared types.
//
// This is the shape createSnapshotService's `content` parameter will
// eventually carry (per B3's own comment: "content JSON value... its
// internal shape... IS the deferred IDM/QG-06 work"), and what
// Working Preview (preview.ts) returns today without freezing
// anything. One shape for both CRD and DRD - `document_type`
// distinguishes which 10 (C01-C10) or 12 (D01-D12) section codes are
// relevant, per QG-06 v1.3's own two separate outlines (C0/D0).

import type { SourceEligibilityFinding } from "../source-resolver.js";
import type { SupportingPath } from "../dependency-closure.js";

export const DOCUMENT_MODEL_VERSION = 1;

export type DocumentType = "CRD" | "DRD";

export type ApplicabilityStatus = "APPLICABLE" | "NOT_APPLICABLE" | "UNDETERMINED";

/**
 * One section's applicability verdict, always paired with its basis -
 * per the approved B3.2 contract, a verdict without a stated reason is
 * never acceptable, and UNDETERMINED (not a forced NOT_APPLICABLE) is
 * the only honest answer when QG-06 does not supply a decidable rule
 * for the data actually on hand.
 */
export interface SectionApplicability {
  status: ApplicabilityStatus;
  basis: string;
}

export type GenerationMethod = "G1" | "G2";

/**
 * One field's value as the Document Model carries it - never bare,
 * always paired with how it was produced and whether it had to fall
 * back to free text. `degraded: true` is a presentation/traceability
 * flag only - it never implies the field passed or failed any
 * completeness check (that remains Quality Core's job, not this
 * module's).
 */
export interface FieldValue {
  value: unknown;
  generation_method: GenerationMethod;
  degraded: boolean;
  degraded_reason: string | null;
}

export type FieldStatus = "PRESENT" | "MISSING_BUSINESS_INFORMATION" | "MISSING_REPRESENTATION";

/**
 * One required-field slot for a section, per QG-06's own field list
 * for that section (M or C). `field_status` makes explicit the
 * distinction the approved contract requires: a field can be absent
 * because the BA simply hasn't recorded that business fact yet
 * (MISSING_BUSINESS_INFORMATION - a source defect per QG-06 A5), or
 * because the current schema has nowhere to record it at all even if
 * the BA wanted to (MISSING_REPRESENTATION - a template defect per
 * QG-06 A5) - these are never collapsed into one generic "missing".
 */
export interface SectionField {
  field_name: string;
  mandatory: "M" | "C";
  field_status: FieldStatus;
  field: FieldValue | null;
  // Set only when field_status is MISSING_REPRESENTATION - names the
  // specific schema gap (e.g. "requirements.structured_detail has no
  // 'input' field"), never invented, always traceable to a B3.1
  // finding or a fresh gap discovered while building this section.
  missing_representation_note: string | null;
}

/**
 * One provenance reference for a section's content - deliberately
 * NOT the same shape as SourceEligibilityFinding (B2.2/B2.3). A
 * SourceRef says "this exact entity revision is where this content
 * came from and what its manifest membership is"; it says nothing
 * about whether that source is Accessible/Relevant/Eligible - a
 * caller who needs that calls resolveSourcePackage separately and
 * joins by entity_id. Keeping them separate is required by the
 * approved B3.2 contract ("SourceRef tách riêng eligibility/guidance").
 */
export interface SourceRef {
  entity_id: string;
  entity_type: string;
  entity_revision_id: string;
  manifest_membership: "INCLUDED" | "CONFIRMABLE" | "REFERENCED_ONLY";
  relation_provenance: SupportingPath[];
}

export interface DocumentSection {
  section_code: string; // "C01".."C10" | "D01".."D12"
  section_title: string;
  applicability: SectionApplicability;
  fields: SectionField[];
  source_refs: SourceRef[];
}

export interface DocumentModel {
  model_version: number;
  document_type: DocumentType;
  case_id: string;
  sections: DocumentSection[];
}

/**
 * The exact source package a DocumentModel was built from - the same
 * (entity_id, entity_revision_id, membership, supporting_paths) tuples
 * resolveSourcePackage/resolveDependencyClosure resolved, never
 * re-resolved after the fact. B3.3's Snapshot Builder passes this back
 * to createSnapshotService, which re-resolves its own scope/closure at
 * freeze time and compares against this reference on all four axes
 * (entity revision, relation revision, dependency path, membership) -
 * see createSnapshotService's own comment on `expected_source_package`
 * for the exact comparison contract.
 */
export interface ResolvedSourcePackageRef {
  scope: Array<{ entity_id: string; entity_revision_id: string; membership: "INCLUDED" | "CONFIRMABLE" }>;
  referenced_only: Array<{
    entity_id: string;
    entity_revision_id: string;
    supporting_paths: SupportingPath[];
  }>;
}

/**
 * Working Preview's full output: the DocumentModel plus the exact
 * source package it was built from (for B3.3 to pass through later)
 * plus the eligibility findings resolveSourcePackage already computed
 * (kept alongside, never merged into SourceRef - see SourceRef's own
 * docblock).
 */
export interface WorkingPreviewResult {
  document_model: DocumentModel;
  source_package_ref: ResolvedSourcePackageRef;
  eligibility_findings: SourceEligibilityFinding[];
}
