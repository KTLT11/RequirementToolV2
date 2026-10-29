// P3-FR-017 / FR-018 — Requirement Formation & Decomposition.
//
// requirements.requirement_id carries a FK to entity_identities
// (confirmed via the repair migration, read in full before writing
// this module - see migration 007's header comment). Every create
// registers a new entity and writes its first revision; every update
// writes the next revision, keeping current_revision_no in the row
// in sync with entity_revisions.
//
// FR-018 (decomposition): requirements has no parent_requirement_id
// column anywhere in the schema - the approved design is to record
// the parent/child link as a DECOMPOSED_FROM traceability_relations
// row instead (source_entity_id = child Requirement,
// target_entity_id = parent Requirement), reusing the existing
// Traceability infrastructure (FR-016) rather than adding a new
// column. Enforced invariants, per the approved decision:
//   - both Requirements must belong to the same Case
//   - a child Requirement may have at most one ACTIVE parent link
//   - no self-reference, no cycle in the decomposition chain

import { HttpError } from "../../http/errors.js";
import { withTransaction } from "../../db/pool.js";
import { registerEntity, createRevision } from "../entities/repository.js";
import {
  findActiveRelation,
  findActiveRelationTypeVersionId,
  insertRelation,
  insertRelationRevision,
  wouldCreateDecompositionCycle,
} from "../traceability/repository.js";
import * as repo from "./repository.js";

const REQUIREMENT_TYPES = ["FUNCTIONAL", "NON_FUNCTIONAL"] as const;
// Lifecycle vocabulary kept minimal and explicit - the schema itself
// has no CHECK constraint on lifecycle_status (defaults to 'DRAFT'),
// so this whitelist is this service's own choice, not a DB rule. Only
// the statuses the SRS actually names are included (DRAFT per
// FR-017 AC-02 "giữ Draft"; QUALITY_READY / STAKEHOLDER_CONFIRMED per
// the framework's Layer 2 checkpoints) - no status invented beyond
// those.
const LIFECYCLE_STATUSES = ["DRAFT", "QUALITY_READY", "STAKEHOLDER_CONFIRMED"] as const;
const DECOMPOSED_FROM = "DECOMPOSED_FROM";

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

// B1.3 Structured Semantic Data - validates SHAPE/TYPE only, per the
// approved contract. A profile key being present with some, but not
// all, of QG-06's fields for that section is accepted as a valid
// partial draft - completeness is Quality Core/Document Coverage's
// job (B4), not this CRUD layer's. This function only rejects a
// request whose JSON does not even match the expected shape (wrong
// type for a field that IS present, or a profile_version that isn't
// a positive integer, or an unknown top-level key).
const STRUCTURED_DETAIL_TOP_LEVEL_KEYS = new Set([
  "profile_version",
  "functional",
  "nfr",
  "reporting",
]);
const FUNCTIONAL_STRING_FIELDS = ["actor", "trigger", "expected_outcome"] as const;
const FUNCTIONAL_STRING_ARRAY_FIELDS = ["preconditions", "conditions"] as const;
const NFR_STRING_FIELDS = [
  "quality_attribute",
  "measurable_target",
  "measurement_condition",
  "verification_method",
] as const;
const REPORTING_STRING_FIELDS = [
  "report_purpose",
  "report_audience",
  "metric_definition",
  "report_grain",
  "aggregation",
  "time_period",
  "access_scope",
] as const;
const REPORTING_STRING_ARRAY_FIELDS = ["filters"] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function validateOptionalStringFields(
  profile: Record<string, unknown>,
  fields: readonly string[],
  profileName: string,
): void {
  for (const field of fields) {
    if (field in profile && profile[field] !== undefined && typeof profile[field] !== "string") {
      throw new HttpError(
        "VALIDATION_ERROR",
        `structured_detail.${profileName}.${field} must be a string when provided`,
      );
    }
  }
}

function validateOptionalStringArrayFields(
  profile: Record<string, unknown>,
  fields: readonly string[],
  profileName: string,
): void {
  for (const field of fields) {
    if (field in profile && profile[field] !== undefined && !isStringArray(profile[field])) {
      throw new HttpError(
        "VALIDATION_ERROR",
        `structured_detail.${profileName}.${field} must be an array of strings when provided`,
      );
    }
  }
}

function validateFunctionalProfile(value: unknown): void {
  if (!isPlainObject(value)) {
    throw new HttpError("VALIDATION_ERROR", "structured_detail.functional must be an object");
  }
  validateOptionalStringFields(value, FUNCTIONAL_STRING_FIELDS, "functional");
  validateOptionalStringArrayFields(value, FUNCTIONAL_STRING_ARRAY_FIELDS, "functional");
}

function validateNfrProfile(value: unknown): void {
  if (!isPlainObject(value)) {
    throw new HttpError("VALIDATION_ERROR", "structured_detail.nfr must be an object");
  }
  validateOptionalStringFields(value, NFR_STRING_FIELDS, "nfr");
}

function validateReportingProfile(value: unknown): void {
  if (!isPlainObject(value)) {
    throw new HttpError("VALIDATION_ERROR", "structured_detail.reporting must be an object");
  }
  validateOptionalStringFields(value, REPORTING_STRING_FIELDS, "reporting");
  validateOptionalStringArrayFields(value, REPORTING_STRING_ARRAY_FIELDS, "reporting");
  if ("metrics" in value && value.metrics !== undefined) {
    if (!Array.isArray(value.metrics)) {
      throw new HttpError("VALIDATION_ERROR", "structured_detail.reporting.metrics must be an array");
    }
    for (const metric of value.metrics) {
      if (!isPlainObject(metric) || typeof metric.name !== "string" || metric.name.trim() === "") {
        throw new HttpError(
          "VALIDATION_ERROR",
          "structured_detail.reporting.metrics[] items must be objects with a non-empty string name",
        );
      }
      if (metric.definition !== undefined && typeof metric.definition !== "string") {
        throw new HttpError(
          "VALIDATION_ERROR",
          "structured_detail.reporting.metrics[].definition must be a string when provided",
        );
      }
    }
  }
}

/**
 * Validates { profile_version, functional?, nfr?, reporting? } shape
 * only - returns the parsed value unchanged (never mutates/defaults
 * missing conditional fields) so repository stores exactly what the
 * caller sent. Returns null when the caller omitted structured_detail
 * entirely - backward compatible with every existing caller that has
 * never heard of this field.
 */
// Exported for validation-only unit tests (test/b13-structured-
// semantic-validation.test.ts) - not otherwise part of this module's
// public contract; callers outside this file should go through
// createRequirementService/updateRequirementService, not this
// function directly.
export function parseStructuredDetail(value: unknown): Record<string, unknown> | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (!isPlainObject(value)) {
    throw new HttpError("VALIDATION_ERROR", "structured_detail must be an object when provided");
  }
  for (const key of Object.keys(value)) {
    if (!STRUCTURED_DETAIL_TOP_LEVEL_KEYS.has(key)) {
      throw new HttpError("VALIDATION_ERROR", `structured_detail has an unknown key: ${key}`);
    }
  }
  if (
    "profile_version" in value &&
    value.profile_version !== undefined &&
    (typeof value.profile_version !== "number" ||
      !Number.isInteger(value.profile_version) ||
      value.profile_version < 1)
  ) {
    throw new HttpError(
      "VALIDATION_ERROR",
      "structured_detail.profile_version must be a positive integer when provided",
    );
  }
  if ("functional" in value && value.functional !== undefined) {
    validateFunctionalProfile(value.functional);
  }
  if ("nfr" in value && value.nfr !== undefined) {
    validateNfrProfile(value.nfr);
  }
  if ("reporting" in value && value.reporting !== undefined) {
    validateReportingProfile(value.reporting);
  }
  return value;
}

export async function listRequirementsService(caseId: string) {
  if (!isUuid(caseId)) {
    throw new HttpError("VALIDATION_ERROR", "case_id must be a valid UUID");
  }
  const rows = await repo.findRequirementsByCaseId(caseId);
  return { data: rows };
}

export async function getRequirementService(requirementId: string) {
  if (!isUuid(requirementId)) {
    throw new HttpError("VALIDATION_ERROR", "requirement_id must be a valid UUID");
  }
  const row = await repo.findRequirementById(requirementId);
  if (!row) {
    throw new HttpError("NOT_FOUND", `Requirement ${requirementId} was not found`);
  }
  return { data: row };
}

export interface CreateRequirementInput {
  requirement_code?: unknown;
  requirement_type?: unknown;
  title?: unknown;
  statement?: unknown;
  rationale?: unknown;
  priority?: unknown;
  structured_detail?: unknown;
}

export async function createRequirementService(
  caseId: string,
  body: CreateRequirementInput,
  callerUserId: string,
) {
  if (!isUuid(caseId)) {
    throw new HttpError("VALIDATION_ERROR", "case_id must be a valid UUID");
  }
  if (!isNonEmptyString(body.requirement_code)) {
    throw new HttpError("VALIDATION_ERROR", "requirement_code is required");
  }
  if (
    typeof body.requirement_type !== "string" ||
    !REQUIREMENT_TYPES.includes(body.requirement_type as (typeof REQUIREMENT_TYPES)[number])
  ) {
    throw new HttpError(
      "VALIDATION_ERROR",
      `requirement_type must be one of: ${REQUIREMENT_TYPES.join(", ")}`,
    );
  }
  if (!isNonEmptyString(body.title)) {
    throw new HttpError("VALIDATION_ERROR", "title is required");
  }
  if (!isNonEmptyString(body.statement)) {
    throw new HttpError("VALIDATION_ERROR", "statement is required");
  }
  const rationale = typeof body.rationale === "string" ? body.rationale : null;
  const priority = typeof body.priority === "string" ? body.priority : null;
  const structuredDetail = parseStructuredDetail(body.structured_detail);

  try {
    const result = await withTransaction(async (client) => {
      const requirementId = await registerEntity(client, "REQUIREMENT");

      const created = await repo.insertRequirement(client, {
        requirementId,
        caseId,
        requirementCode: body.requirement_code as string,
        requirementType: body.requirement_type as string,
        title: body.title as string,
        statement: body.statement as string,
        rationale,
        priority,
        structuredDetail,
      });

      // Revision snapshot fidelity (B1.3): content must carry every
      // mutable canonical field, not just title/statement/
      // lifecycle_status - rationale, priority and structured_detail
      // can all change over a Requirement's life and must be
      // recoverable at an exact past revision (see B1.1's
      // getEntityRevisionService). Historical revisions written
      // before this change keep their narrower shape - this is a
      // forward-only fidelity improvement, never backfilled.
      await createRevision(client, {
        entityId: requirementId,
        revisionNo: 1,
        content: {
          title: created.title,
          statement: created.statement,
          rationale: created.rationale,
          priority: created.priority,
          lifecycle_status: created.lifecycle_status,
          structured_detail: created.structured_detail,
        },
        createdBy: callerUserId,
        changeSummary: "Requirement created",
      });

      return created;
    });

    return { data: result };
  } catch (err) {
    if (
      typeof err === "object" &&
      err !== null &&
      "code" in err &&
      (err as { code?: string }).code === "23505"
    ) {
      throw new HttpError("CONFLICT", "requirement_code already exists for this case");
    }
    throw err;
  }
}

export interface UpdateRequirementInput {
  title?: unknown;
  statement?: unknown;
  rationale?: unknown;
  lifecycle_status?: unknown;
  priority?: unknown;
  structured_detail?: unknown;
}

export async function updateRequirementService(
  requirementId: string,
  body: UpdateRequirementInput,
  callerUserId: string,
) {
  if (!isUuid(requirementId)) {
    throw new HttpError("VALIDATION_ERROR", "requirement_id must be a valid UUID");
  }
  if (!isNonEmptyString(body.title)) {
    throw new HttpError("VALIDATION_ERROR", "title is required");
  }
  if (!isNonEmptyString(body.statement)) {
    throw new HttpError("VALIDATION_ERROR", "statement is required");
  }
  if (
    typeof body.lifecycle_status !== "string" ||
    !LIFECYCLE_STATUSES.includes(body.lifecycle_status as (typeof LIFECYCLE_STATUSES)[number])
  ) {
    throw new HttpError(
      "VALIDATION_ERROR",
      `lifecycle_status must be one of: ${LIFECYCLE_STATUSES.join(", ")}`,
    );
  }
  const rationale = typeof body.rationale === "string" ? body.rationale : null;
  const priority = typeof body.priority === "string" ? body.priority : null;
  // Same whole-value-replacement semantics as rationale/priority
  // above (this endpoint behaves as a full replace, not a sparse
  // PATCH-merge) - omitting structured_detail clears it to null
  // rather than preserving the previous value, consistent with how
  // this same call already treats every other optional field.
  const structuredDetail = parseStructuredDetail(body.structured_detail);

  const existing = await repo.findRequirementById(requirementId);
  if (!existing) {
    throw new HttpError("NOT_FOUND", `Requirement ${requirementId} was not found`);
  }

  const newRevisionNo = existing.current_revision_no + 1;

  const result = await withTransaction(async (client) => {
    const updated = await repo.updateRequirement(client, {
      requirementId,
      title: body.title as string,
      statement: body.statement as string,
      rationale,
      lifecycleStatus: body.lifecycle_status as string,
      priority,
      structuredDetail,
      newRevisionNo,
    });

    if (!updated) {
      throw new HttpError("NOT_FOUND", `Requirement ${requirementId} was not found`);
    }

    await createRevision(client, {
      entityId: requirementId,
      revisionNo: newRevisionNo,
      content: {
        title: updated.title,
        statement: updated.statement,
        rationale: updated.rationale,
        priority: updated.priority,
        lifecycle_status: updated.lifecycle_status,
        structured_detail: updated.structured_detail,
      },
      createdBy: callerUserId,
      changeSummary: "Requirement updated",
    });

    return updated;
  });

  return { data: result };
}

export interface SplitRequirementInput {
  requirement_code?: unknown;
  requirement_type?: unknown;
  title?: unknown;
  statement?: unknown;
  rationale?: unknown;
  priority?: unknown;
}

/**
 * P3-FR-018 — creates a new child Requirement under the same Case as
 * `parentRequirementId`, linked back to it via a DECOMPOSED_FROM
 * traceability_relations row (source = child, target = parent).
 */
export async function splitRequirementService(
  parentRequirementId: string,
  body: SplitRequirementInput,
  callerUserId: string,
) {
  if (!isUuid(parentRequirementId)) {
    throw new HttpError("VALIDATION_ERROR", "requirement_id must be a valid UUID");
  }

  const parent = await repo.findRequirementById(parentRequirementId);
  if (!parent) {
    throw new HttpError("NOT_FOUND", `Requirement ${parentRequirementId} was not found`);
  }

  if (!isNonEmptyString(body.requirement_code)) {
    throw new HttpError("VALIDATION_ERROR", "requirement_code is required");
  }
  if (
    typeof body.requirement_type !== "string" ||
    !REQUIREMENT_TYPES.includes(body.requirement_type as (typeof REQUIREMENT_TYPES)[number])
  ) {
    throw new HttpError(
      "VALIDATION_ERROR",
      `requirement_type must be one of: ${REQUIREMENT_TYPES.join(", ")}`,
    );
  }
  if (!isNonEmptyString(body.title)) {
    throw new HttpError("VALIDATION_ERROR", "title is required");
  }
  if (!isNonEmptyString(body.statement)) {
    throw new HttpError("VALIDATION_ERROR", "statement is required");
  }
  const rationale = typeof body.rationale === "string" ? body.rationale : null;
  const priority = typeof body.priority === "string" ? body.priority : null;

  const relationTypeVersionId = await findActiveRelationTypeVersionId(DECOMPOSED_FROM);
  if (!relationTypeVersionId) {
    // Genuine schema/seed gap, not a client input error - migration
    // 007 seeds this exact relation type, so reaching here means that
    // migration has not been applied yet.
    throw new HttpError(
      "VALIDATION_ERROR",
      "DECOMPOSED_FROM relation type is not seeded - apply migration 007 first",
    );
  }

  try {
    const result = await withTransaction(async (client) => {
      const childRequirementId = await registerEntity(client, "REQUIREMENT");

      // Same-Case constraint is enforced by construction: the new
      // child row is always inserted with parent.case_id, never a
      // client-supplied case_id, so it is structurally impossible for
      // the two Requirements to end up in different Cases.
      // structured_detail is not part of SplitRequirementInput (out of
      // scope for B1.3 - split's own contract is unchanged) - always
      // null for a freshly split child, same as rationale/priority
      // default when the caller omits them.
      const child = await repo.insertRequirement(client, {
        requirementId: childRequirementId,
        caseId: parent.case_id,
        requirementCode: body.requirement_code as string,
        requirementType: body.requirement_type as string,
        title: body.title as string,
        statement: body.statement as string,
        rationale,
        priority,
        structuredDetail: null,
      });

      await createRevision(client, {
        entityId: childRequirementId,
        revisionNo: 1,
        content: {
          title: child.title,
          statement: child.statement,
          rationale: child.rationale,
          priority: child.priority,
          lifecycle_status: child.lifecycle_status,
          structured_detail: child.structured_detail,
        },
        createdBy: callerUserId,
        changeSummary: `Requirement created via split from ${parentRequirementId}`,
      });

      // No self-reference possible here (childRequirementId is freshly
      // generated), and no cycle possible either (a brand-new entity
      // cannot already be an ancestor of anything) - the cycle check
      // exists for completeness/defense-in-depth and to keep the
      // invariant explicit in code, not because this specific call
      // path could trigger it.
      const cyclic = await wouldCreateDecompositionCycle({
        childEntityId: childRequirementId,
        parentEntityId: parentRequirementId,
      });
      if (cyclic) {
        throw new HttpError(
          "VALIDATION_ERROR",
          "This split would create a decomposition cycle",
        );
      }

      const relation = await insertRelation(client, {
        relationTypeVersionId,
        sourceEntityId: childRequirementId,
        targetEntityId: parentRequirementId,
        createdBy: callerUserId,
      });

      await insertRelationRevision(client, {
        relationId: relation.relation_id,
        revisionNo: 1,
        relationAction: "CREATE",
        relationPayload: {
          relation_type: DECOMPOSED_FROM,
          child_requirement_id: childRequirementId,
          parent_requirement_id: parentRequirementId,
        },
        changedBy: callerUserId,
      });

      return { requirement: child, decomposedFrom: parentRequirementId };
    });

    return { data: result };
  } catch (err) {
    if (
      typeof err === "object" &&
      err !== null &&
      "code" in err &&
      (err as { code?: string }).code === "23505"
    ) {
      throw new HttpError("CONFLICT", "requirement_code already exists for this case");
    }
    throw err;
  }
}

/**
 * Enforces "a child Requirement may have at most one ACTIVE parent
 * link" before allowing a split to proceed a second time from the
 * same child - called separately from splitRequirementService
 * because it checks the *child* side, which does not exist yet
 * inside that function (the child is only created there). In
 * practice this guard applies to a future "re-parent" operation, not
 * yet exposed as an endpoint in this slice; kept here, unused by any
 * route yet, so the invariant is enforced the moment such an endpoint
 * is added rather than being designed in after the fact.
 */
export async function assertNoExistingParentLink(childEntityId: string): Promise<void> {
  const existing = await findActiveRelation({
    relationTypeCode: DECOMPOSED_FROM,
    sourceEntityId: childEntityId,
  });
  if (existing) {
    throw new HttpError(
      "VALIDATION_ERROR",
      "This Requirement already has an active DECOMPOSED_FROM parent link",
    );
  }
}
