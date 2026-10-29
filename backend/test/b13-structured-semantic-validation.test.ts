// Validation-only tests for B1.3 Structured Semantic Data
// (requirements.structured_detail, business_rules.rule_detail).
// Cases that need a real database (full create/update round-trip,
// revision snapshot content, consistency with other canonical
// fields) live in test/integration.ts instead.
//
// Per the approved contract, parseStructuredDetail/parseRuleDetail
// validate SHAPE/TYPE only - a profile/kind present but missing some
// QG-06 "mandatory when applicable" business field must be ACCEPTED
// as a valid partial draft, never rejected. The "accepts a partial
// ... draft" tests below assert exactly that, since the easy mistake
// to introduce later is a well-intentioned completeness check that
// silently turns this CRUD layer into a gatekeeper that B4/Quality
// Core alone is supposed to be.

import { test } from "node:test";
import assert from "node:assert/strict";
import { HttpError } from "../src/http/errors.js";
import { parseStructuredDetail } from "../src/modules/requirements/service.js";
import { parseRuleDetail } from "../src/modules/business-rules/service.js";

function expectHttpError(fn: () => unknown, code: string): void {
  try {
    fn();
    assert.fail("expected an HttpError to be thrown");
  } catch (err) {
    assert.ok(err instanceof HttpError, "expected HttpError, got: " + String(err));
    assert.equal(err.code, code);
  }
}

// --- parseStructuredDetail (requirements) ---

test("parseStructuredDetail returns null when omitted (backward compatible)", () => {
  assert.equal(parseStructuredDetail(undefined), null);
  assert.equal(parseStructuredDetail(null), null);
});

test("parseStructuredDetail rejects a non-object value", () => {
  expectHttpError(() => parseStructuredDetail("not an object"), "VALIDATION_ERROR");
  expectHttpError(() => parseStructuredDetail(42), "VALIDATION_ERROR");
  expectHttpError(() => parseStructuredDetail(["array"]), "VALIDATION_ERROR");
});

test("parseStructuredDetail rejects an unknown top-level key", () => {
  expectHttpError(() => parseStructuredDetail({ unknown_field: "x" }), "VALIDATION_ERROR");
});

test("parseStructuredDetail rejects a non-positive-integer profile_version", () => {
  expectHttpError(() => parseStructuredDetail({ profile_version: 0 }), "VALIDATION_ERROR");
  expectHttpError(() => parseStructuredDetail({ profile_version: 1.5 }), "VALIDATION_ERROR");
  expectHttpError(() => parseStructuredDetail({ profile_version: "1" }), "VALIDATION_ERROR");
});

test("parseStructuredDetail accepts a partial functional draft missing most fields", () => {
  const result = parseStructuredDetail({ profile_version: 1, functional: { actor: "Customer" } });
  assert.deepEqual(result, { profile_version: 1, functional: { actor: "Customer" } });
});

test("parseStructuredDetail accepts an empty functional profile object", () => {
  const result = parseStructuredDetail({ functional: {} });
  assert.deepEqual(result, { functional: {} });
});

test("parseStructuredDetail rejects a non-string functional field", () => {
  expectHttpError(() => parseStructuredDetail({ functional: { actor: 123 } }), "VALIDATION_ERROR");
});

test("parseStructuredDetail rejects a non-string-array functional field", () => {
  expectHttpError(
    () => parseStructuredDetail({ functional: { preconditions: "not an array" } }),
    "VALIDATION_ERROR",
  );
  expectHttpError(
    () => parseStructuredDetail({ functional: { preconditions: [1, 2] } }),
    "VALIDATION_ERROR",
  );
});

test("parseStructuredDetail accepts a partial NFR draft missing mandatory-when-applicable fields", () => {
  // Per the approved contract, a caller may send only
  // quality_attribute and omit measurable_target/measurement_condition/
  // verification_method entirely - this is a valid draft, not an error.
  const result = parseStructuredDetail({ nfr: { quality_attribute: "Performance" } });
  assert.deepEqual(result, { nfr: { quality_attribute: "Performance" } });
});

test("parseStructuredDetail rejects a non-string NFR field", () => {
  expectHttpError(
    () => parseStructuredDetail({ nfr: { measurable_target: 100 } }),
    "VALIDATION_ERROR",
  );
});

test("parseStructuredDetail allows functional and reporting profiles to coexist on one requirement", () => {
  const result = parseStructuredDetail({
    functional: { actor: "Ops user" },
    reporting: { report_purpose: "Monthly summary" },
  });
  assert.deepEqual(result, {
    functional: { actor: "Ops user" },
    reporting: { report_purpose: "Monthly summary" },
  });
});

test("parseStructuredDetail accepts a partial reporting draft with only metrics", () => {
  const result = parseStructuredDetail({
    reporting: { metrics: [{ name: "Total revenue" }] },
  });
  assert.deepEqual(result, { reporting: { metrics: [{ name: "Total revenue" }] } });
});

test("parseStructuredDetail rejects a reporting metric missing a name", () => {
  expectHttpError(
    () => parseStructuredDetail({ reporting: { metrics: [{ definition: "sum of x" }] } }),
    "VALIDATION_ERROR",
  );
  expectHttpError(
    () => parseStructuredDetail({ reporting: { metrics: [{ name: "" }] } }),
    "VALIDATION_ERROR",
  );
});

test("parseStructuredDetail rejects reporting.metrics that is not an array", () => {
  expectHttpError(
    () => parseStructuredDetail({ reporting: { metrics: "not an array" } }),
    "VALIDATION_ERROR",
  );
});

// --- parseRuleDetail (business_rules) ---

test("parseRuleDetail returns null when omitted (backward compatible)", () => {
  assert.equal(parseRuleDetail(undefined, "CONSTRAINT"), null);
  assert.equal(parseRuleDetail(null, "CONSTRAINT"), null);
});

test("parseRuleDetail rejects a non-object value", () => {
  expectHttpError(() => parseRuleDetail("text", "CONSTRAINT"), "VALIDATION_ERROR");
});

test("parseRuleDetail requires a valid kind", () => {
  expectHttpError(() => parseRuleDetail({}, "CONSTRAINT"), "VALIDATION_ERROR");
  expectHttpError(() => parseRuleDetail({ kind: "NOT_A_KIND" }, "CONSTRAINT"), "VALIDATION_ERROR");
});

test("parseRuleDetail accepts a partial SIMPLE draft missing action_outcome", () => {
  const result = parseRuleDetail({ kind: "SIMPLE", condition: "amount < 1000" }, "CONSTRAINT");
  assert.deepEqual(result, { kind: "SIMPLE", condition: "amount < 1000" });
});

test("parseRuleDetail enforces kind-vs-rule_type compatibility", () => {
  // DECISION_TABLE is not allowed for CONSTRAINT per the approved
  // matrix (CONSTRAINT -> SIMPLE, MULTI_CONDITION only).
  expectHttpError(
    () => parseRuleDetail({ kind: "DECISION_TABLE", columns: [], rows: [] }, "CONSTRAINT"),
    "VALIDATION_ERROR",
  );
  // CALCULATION rule_type requires CALCULATION kind.
  expectHttpError(
    () => parseRuleDetail({ kind: "SIMPLE", condition: "x" }, "CALCULATION"),
    "VALIDATION_ERROR",
  );
});

test("parseRuleDetail allows DECISION_TABLE kind for DECISION rule_type", () => {
  const result = parseRuleDetail(
    { kind: "DECISION_TABLE", columns: ["tier", "discount"], rows: [["gold", "10%"]] },
    "DECISION",
  );
  assert.deepEqual(result, {
    kind: "DECISION_TABLE",
    columns: ["tier", "discount"],
    rows: [["gold", "10%"]],
  });
});

test("parseRuleDetail accepts a partial CALCULATION draft missing formula", () => {
  // Per the approved contract this is a valid partial draft, not a
  // rejection - a CALCULATION rule that has no formula yet is still
  // an accepted structural shape, just business-incomplete.
  const result = parseRuleDetail({ kind: "CALCULATION", condition: "qty > 0" }, "CALCULATION");
  assert.deepEqual(result, { kind: "CALCULATION", condition: "qty > 0" });
});

test("parseRuleDetail rejects a non-object CALCULATION values field", () => {
  expectHttpError(
    () => parseRuleDetail({ kind: "CALCULATION", values: "not an object" }, "CALCULATION"),
    "VALIDATION_ERROR",
  );
});

test("parseRuleDetail OTHER rule_type accepts any kind", () => {
  const result = parseRuleDetail({ kind: "DECISION_TABLE" }, "OTHER");
  assert.deepEqual(result, { kind: "DECISION_TABLE" });
});

test("parseRuleDetail validates MULTI_CONDITION conditions shape", () => {
  expectHttpError(
    () => parseRuleDetail({ kind: "MULTI_CONDITION", conditions: "not an array" }, "CONSTRAINT"),
    "VALIDATION_ERROR",
  );
  expectHttpError(
    () =>
      parseRuleDetail(
        { kind: "MULTI_CONDITION", conditions: [{ expression: "x > 1", logic_operator: "XOR" }] },
        "CONSTRAINT",
      ),
    "VALIDATION_ERROR",
  );
  const ok = parseRuleDetail(
    { kind: "MULTI_CONDITION", conditions: [{ expression: "x > 1", logic_operator: "AND" }] },
    "CONSTRAINT",
  );
  assert.deepEqual(ok, {
    kind: "MULTI_CONDITION",
    conditions: [{ expression: "x > 1", logic_operator: "AND" }],
  });
});

test("parseRuleDetail rejects a non-integer precedence", () => {
  expectHttpError(
    () => parseRuleDetail({ kind: "MULTI_CONDITION", precedence: 1.5 }, "CONSTRAINT"),
    "VALIDATION_ERROR",
  );
});
