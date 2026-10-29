// Business Rule (public.business_rules) — a Case-owned, versioned,
// canonical business rule discovered via the Business Rule Discovery
// Module (RULE-Q-01..14 in the Rule Registry), referenceable by many
// Requirements. UNIQUE(case_id, rule_code); rule_id carries a FK to
// entity_identities (confirmed via the repair migration).
//
// Deliberately distinct from two other things that could be confused
// with it:
//   1. The simple rule content embedded inline inside a Requirement's
//      own `statement` text (Requirement Formation, FR-017) — that is
//      just prose inside one Requirement, not an independently
//      versioned, cross-referenceable object. A BusinessRule row
//      exists specifically so multiple Requirements can point at the
//      same rule and see it evolve independently of any one of them.
//   2. CHECK_RULE definitions in the Rule Registry
//      (definition_versions.definition_type = 'CHECK_RULE') — those
//      belong to the Validation Engine (FR-020/023, not implemented
//      in this slice) and describe *how to evaluate* a requirement
//      for quality, not a *business* rule discovered from the
//      customer's domain. business_rules and CHECK_RULE are different
//      tables entirely; this module never reads or writes
//      definition_versions.

import { HttpError } from "../../http/errors.js";
import { withTransaction } from "../../db/pool.js";
import { registerEntity, createRevision } from "../entities/repository.js";
import * as repo from "./repository.js";

// rule_type vocabulary taken directly from the Data Dictionary's own
// example values for this column ("CONSTRAINT, DECISION, CALCULATION,
// etc.") - kept open-ended (no DB CHECK constraint exists on this
// column either) but anchored to the 3 named examples plus the
// generic bucket the Dictionary itself implies with "etc.".
const RULE_TYPES = ["CONSTRAINT", "DECISION", "CALCULATION", "OTHER"] as const;
const RULE_STATUSES = ["DRAFT", "ACTIVE", "SUPERSEDED"] as const;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// B1.3 Structured Semantic Data - rule_detail. "kind" describes the
// STRUCTURAL SHAPE of the rule's data (does it have one condition or
// many? a formula? a full decision table?), independent of rule_type
// (which describes the rule's PURPOSE - constraint/decision/
// calculation/other). The approved contract's compatibility matrix:
//   CONSTRAINT  -> SIMPLE, MULTI_CONDITION
//   DECISION    -> SIMPLE, MULTI_CONDITION, DECISION_TABLE
//   CALCULATION -> CALCULATION only
//   OTHER       -> any kind, or no rule_detail at all
const RULE_DETAIL_KINDS = ["SIMPLE", "CALCULATION", "MULTI_CONDITION", "DECISION_TABLE"] as const;
type RuleDetailKind = (typeof RULE_DETAIL_KINDS)[number];

const ALLOWED_KINDS_BY_RULE_TYPE: Record<string, readonly RuleDetailKind[]> = {
  CONSTRAINT: ["SIMPLE", "MULTI_CONDITION"],
  DECISION: ["SIMPLE", "MULTI_CONDITION", "DECISION_TABLE"],
  CALCULATION: ["CALCULATION"],
  // OTHER accepts any kind - no entry needed, see the "OTHER" branch
  // in validateRuleDetail below.
};

function validateOptionalStringField(
  obj: Record<string, unknown>,
  field: string,
  path: string,
): void {
  if (field in obj && obj[field] !== undefined && typeof obj[field] !== "string") {
    throw new HttpError("VALIDATION_ERROR", `${path}.${field} must be a string when provided`);
  }
}

function validateSimpleKind(detail: Record<string, unknown>): void {
  validateOptionalStringField(detail, "condition", "rule_detail");
  validateOptionalStringField(detail, "action_outcome", "rule_detail");
}

function validateCalculationKind(detail: Record<string, unknown>): void {
  validateOptionalStringField(detail, "condition", "rule_detail");
  validateOptionalStringField(detail, "formula", "rule_detail");
  validateOptionalStringField(detail, "units", "rule_detail");
  validateOptionalStringField(detail, "rounding", "rule_detail");
  if ("values" in detail && detail.values !== undefined && !isPlainObject(detail.values)) {
    throw new HttpError("VALIDATION_ERROR", "rule_detail.values must be an object when provided");
  }
}

function validateMultiConditionKind(detail: Record<string, unknown>): void {
  if ("conditions" in detail && detail.conditions !== undefined) {
    if (!Array.isArray(detail.conditions)) {
      throw new HttpError("VALIDATION_ERROR", "rule_detail.conditions must be an array");
    }
    for (const condition of detail.conditions) {
      if (!isPlainObject(condition) || typeof condition.expression !== "string") {
        throw new HttpError(
          "VALIDATION_ERROR",
          "rule_detail.conditions[] items must be objects with a string expression",
        );
      }
      if (
        condition.logic_operator !== undefined &&
        condition.logic_operator !== "AND" &&
        condition.logic_operator !== "OR"
      ) {
        throw new HttpError(
          "VALIDATION_ERROR",
          "rule_detail.conditions[].logic_operator must be \"AND\" or \"OR\" when provided",
        );
      }
    }
  }
  validateOptionalStringField(detail, "action_outcome", "rule_detail");
  if (
    "precedence" in detail &&
    detail.precedence !== undefined &&
    (typeof detail.precedence !== "number" || !Number.isInteger(detail.precedence))
  ) {
    throw new HttpError("VALIDATION_ERROR", "rule_detail.precedence must be an integer when provided");
  }
}

function validateDecisionTableKind(detail: Record<string, unknown>): void {
  if ("columns" in detail && detail.columns !== undefined) {
    if (!Array.isArray(detail.columns) || !detail.columns.every((c) => typeof c === "string")) {
      throw new HttpError("VALIDATION_ERROR", "rule_detail.columns must be an array of strings");
    }
  }
  if ("rows" in detail && detail.rows !== undefined) {
    if (!Array.isArray(detail.rows) || !detail.rows.every((r) => Array.isArray(r))) {
      throw new HttpError("VALIDATION_ERROR", "rule_detail.rows must be an array of arrays");
    }
  }
  if (
    "precedence" in detail &&
    detail.precedence !== undefined &&
    (typeof detail.precedence !== "number" || !Number.isInteger(detail.precedence))
  ) {
    throw new HttpError("VALIDATION_ERROR", "rule_detail.precedence must be an integer when provided");
  }
  validateOptionalStringField(detail, "conflict_resolution", "rule_detail");
}

/**
 * Validates { profile_version, kind, ...fields-by-kind } SHAPE/TYPE
 * only, and kind-vs-rule_type compatibility, per the approved
 * contract - never rejects a write merely because a conditional
 * business field (e.g. CALCULATION with no formula yet) is missing.
 * Returns the parsed value unchanged, or null when the caller omitted
 * rule_detail entirely (backward compatible with every existing
 * caller).
 */
// Exported for validation-only unit tests (test/b13-structured-
// semantic-validation.test.ts) - not otherwise part of this module's
// public contract; callers outside this file should go through
// createRuleService/updateRuleService, not this function directly.
export function parseRuleDetail(value: unknown, ruleType: string): Record<string, unknown> | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (!isPlainObject(value)) {
    throw new HttpError("VALIDATION_ERROR", "rule_detail must be an object when provided");
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
      "rule_detail.profile_version must be a positive integer when provided",
    );
  }
  if (typeof value.kind !== "string" || !RULE_DETAIL_KINDS.includes(value.kind as RuleDetailKind)) {
    throw new HttpError(
      "VALIDATION_ERROR",
      `rule_detail.kind must be one of: ${RULE_DETAIL_KINDS.join(", ")}`,
    );
  }
  const kind = value.kind as RuleDetailKind;
  const allowedKinds = ALLOWED_KINDS_BY_RULE_TYPE[ruleType];
  if (allowedKinds && !allowedKinds.includes(kind)) {
    throw new HttpError(
      "VALIDATION_ERROR",
      `rule_detail.kind "${kind}" is not compatible with rule_type "${ruleType}" - allowed: ${allowedKinds.join(", ")}`,
    );
  }

  switch (kind) {
    case "SIMPLE":
      validateSimpleKind(value);
      break;
    case "CALCULATION":
      validateCalculationKind(value);
      break;
    case "MULTI_CONDITION":
      validateMultiConditionKind(value);
      break;
    case "DECISION_TABLE":
      validateDecisionTableKind(value);
      break;
  }

  return value;
}

export async function listRulesService(caseId: string) {
  if (!isUuid(caseId)) {
    throw new HttpError("VALIDATION_ERROR", "case_id must be a valid UUID");
  }
  const rows = await repo.findRulesByCaseId(caseId);
  return { data: rows };
}

export interface CreateRuleInput {
  rule_code?: unknown;
  rule_statement?: unknown;
  rule_type?: unknown;
  rule_detail?: unknown;
}

export async function createRuleService(
  caseId: string,
  body: CreateRuleInput,
  callerUserId: string,
) {
  if (!isUuid(caseId)) {
    throw new HttpError("VALIDATION_ERROR", "case_id must be a valid UUID");
  }
  if (!isNonEmptyString(body.rule_code)) {
    throw new HttpError("VALIDATION_ERROR", "rule_code is required");
  }
  if (!isNonEmptyString(body.rule_statement)) {
    throw new HttpError("VALIDATION_ERROR", "rule_statement is required");
  }
  if (
    typeof body.rule_type !== "string" ||
    !RULE_TYPES.includes(body.rule_type as (typeof RULE_TYPES)[number])
  ) {
    throw new HttpError("VALIDATION_ERROR", `rule_type must be one of: ${RULE_TYPES.join(", ")}`);
  }
  const ruleDetail = parseRuleDetail(body.rule_detail, body.rule_type);

  try {
    const result = await withTransaction(async (client) => {
      const ruleId = await registerEntity(client, "BUSINESS_RULE");

      const created = await repo.insertRule(client, {
        ruleId,
        caseId,
        ruleCode: body.rule_code as string,
        ruleStatement: body.rule_statement as string,
        ruleType: body.rule_type as string,
        ruleDetail,
      });

      // Revision snapshot fidelity (B1.3): rule_detail is a mutable
      // canonical field and must be recoverable at an exact past
      // revision, same reasoning as requirements/service.ts.
      // Historical revisions written before this change keep their
      // narrower shape - forward-only, never backfilled.
      await createRevision(client, {
        entityId: ruleId,
        revisionNo: 1,
        content: {
          rule_statement: created.rule_statement,
          status: created.status,
          rule_detail: created.rule_detail,
        },
        createdBy: callerUserId,
        changeSummary: "Business rule created",
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
      throw new HttpError("CONFLICT", "rule_code already exists for this case");
    }
    throw err;
  }
}

export interface UpdateRuleInput {
  rule_statement?: unknown;
  status?: unknown;
  rule_detail?: unknown;
}

export async function updateRuleService(
  ruleId: string,
  body: UpdateRuleInput,
  callerUserId: string,
) {
  if (!isUuid(ruleId)) {
    throw new HttpError("VALIDATION_ERROR", "rule_id must be a valid UUID");
  }
  if (!isNonEmptyString(body.rule_statement)) {
    throw new HttpError("VALIDATION_ERROR", "rule_statement is required");
  }
  if (
    typeof body.status !== "string" ||
    !RULE_STATUSES.includes(body.status as (typeof RULE_STATUSES)[number])
  ) {
    throw new HttpError("VALIDATION_ERROR", `status must be one of: ${RULE_STATUSES.join(", ")}`);
  }

  const existing = await repo.findRuleById(ruleId);
  if (!existing) {
    throw new HttpError("NOT_FOUND", `Business rule ${ruleId} was not found`);
  }

  // rule_type is immutable after creation (not part of the UPDATE
  // statement below), so kind-vs-rule_type compatibility is checked
  // against the existing row's rule_type, not anything from the
  // request body.
  const ruleDetail = parseRuleDetail(body.rule_detail, existing.rule_type);

  const newRevisionNo = existing.current_revision_no + 1;

  const result = await withTransaction(async (client) => {
    const updated = await repo.updateRule(client, {
      ruleId,
      ruleStatement: body.rule_statement as string,
      status: body.status as string,
      ruleDetail,
      newRevisionNo,
    });

    if (!updated) {
      throw new HttpError("NOT_FOUND", `Business rule ${ruleId} was not found`);
    }

    await createRevision(client, {
      entityId: ruleId,
      revisionNo: newRevisionNo,
      content: {
        rule_statement: updated.rule_statement,
        status: updated.status,
        rule_detail: updated.rule_detail,
      },
      createdBy: callerUserId,
      changeSummary: "Business rule updated",
    });

    return updated;
  });

  return { data: result };
}
