// Validation-only tests for B3.2 Versioned Document Model & Section
// Registry. Full section building (22 sections, G1/G2 reads against
// real data, SourceRef resolution) requires a live database and is
// exercised end-to-end in test/integration.ts's "Working Preview
// (B3.2)" section instead.
//
// What IS checked here, without a database: the applicability
// decision functions never invent a numeric threshold QG-06 does not
// specify (per the approved contract's #3) - this is the single
// easiest invariant for a future edit to silently break by adding a
// "more than N steps = APPLICABLE" style shortcut.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  always,
  workflowDependentApplicability,
  ruleDependentApplicability,
  noRepresentationApplicability,
  profilePresenceApplicability,
} from "../src/modules/documents/document-model/applicability.js";
import { DOCUMENT_MODEL_VERSION } from "../src/modules/documents/document-model/types.js";

test("always() returns APPLICABLE with a QG-06-sourced basis", () => {
  const result = always();
  assert.equal(result.status, "APPLICABLE");
  assert.ok(result.basis.length > 0);
});

test("workflowDependentApplicability returns NOT_APPLICABLE only when no workflow is linked at all", () => {
  const result = workflowDependentApplicability({
    hasLinkedWorkflow: false,
    stepCount: null,
    qg06ConditionQuote: "test condition",
  });
  assert.equal(result.status, "NOT_APPLICABLE");
});

test("workflowDependentApplicability never returns APPLICABLE purely from step count - it is UNDETERMINED when QG-06 gives no numeric threshold", () => {
  // Per approved contract #3: step count alone must never decide
  // APPLICABLE/NOT_APPLICABLE when QG-06's own condition is
  // qualitative ("nhiều bước", no number given).
  const fewSteps = workflowDependentApplicability({
    hasLinkedWorkflow: true,
    stepCount: 2,
    qg06ConditionQuote: "test condition",
  });
  assert.equal(fewSteps.status, "UNDETERMINED");

  const manySteps = workflowDependentApplicability({
    hasLinkedWorkflow: true,
    stepCount: 50,
    qg06ConditionQuote: "test condition",
  });
  assert.equal(manySteps.status, "UNDETERMINED");
});

test("ruleDependentApplicability returns NOT_APPLICABLE only when no rule is linked at all", () => {
  const result = ruleDependentApplicability({ hasAnyRule: false, sharedRuleCount: 0, hasStructuredComplexKind: false });
  assert.equal(result.status, "NOT_APPLICABLE");
});

test("ruleDependentApplicability returns APPLICABLE when a rule is objectively shared (relation count), not from a guessed threshold", () => {
  const result = ruleDependentApplicability({ hasAnyRule: true, sharedRuleCount: 1, hasStructuredComplexKind: false });
  assert.equal(result.status, "APPLICABLE");
});

test("ruleDependentApplicability returns APPLICABLE when structured rule_detail.kind objectively classifies complexity", () => {
  const result = ruleDependentApplicability({ hasAnyRule: true, sharedRuleCount: 0, hasStructuredComplexKind: true });
  assert.equal(result.status, "APPLICABLE");
});

test("ruleDependentApplicability returns UNDETERMINED, not NOT_APPLICABLE, when a rule exists but complexity cannot be decided from structured data", () => {
  const result = ruleDependentApplicability({ hasAnyRule: true, sharedRuleCount: 0, hasStructuredComplexKind: false });
  assert.equal(result.status, "UNDETERMINED");
});

test("noRepresentationApplicability never returns NOT_APPLICABLE - absence of a source/table is never proof of non-applicability", () => {
  const result = noRepresentationApplicability("no Permission table exists");
  assert.equal(result.status, "UNDETERMINED");
  assert.ok(result.basis.includes("no Permission table exists"));
});

test("profilePresenceApplicability returns APPLICABLE only when a structured profile is objectively present", () => {
  const present = profilePresenceApplicability({ profileName: "nfr", anyRequirementHasProfile: true });
  assert.equal(present.status, "APPLICABLE");

  const absent = profilePresenceApplicability({ profileName: "nfr", anyRequirementHasProfile: false });
  assert.equal(absent.status, "UNDETERMINED");
});

test("DOCUMENT_MODEL_VERSION is a positive integer", () => {
  assert.ok(Number.isInteger(DOCUMENT_MODEL_VERSION) && DOCUMENT_MODEL_VERSION > 0);
});
