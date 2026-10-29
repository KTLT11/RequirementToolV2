// Validation-only tests for Requirement, Acceptance Criteria,
// Business Rule, Workflow, and Business Data Definition services -
// every assertion here throws before any database query runs.

import { test } from "node:test";
import assert from "node:assert/strict";
import { HttpError } from "../src/http/errors.js";
import {
  createRequirementService,
  splitRequirementService,
  updateRequirementService,
} from "../src/modules/requirements/service.js";
import { createAcService, updateAcService } from "../src/modules/acceptance-criteria/service.js";
import { createRuleService, updateRuleService } from "../src/modules/business-rules/service.js";
import {
  createStepService,
  createTransitionService,
  createWorkflowService,
} from "../src/modules/workflows/service.js";
import {
  createAttributeService,
  createDataDefinitionService,
} from "../src/modules/data-definitions/service.js";

const FAKE_ID = "00000000-0000-0000-0000-000000000003";

async function expectHttpError(fn: () => Promise<unknown>, code: string): Promise<void> {
  try {
    await fn();
    assert.fail("expected an HttpError to be thrown");
  } catch (err) {
    assert.ok(err instanceof HttpError, "expected HttpError, got: " + String(err));
    assert.equal(err.code, code);
  }
}

// --- Requirement ---

test("createRequirementService rejects a missing requirement_code", async () => {
  await expectHttpError(
    () =>
      createRequirementService(
        FAKE_ID,
        { requirement_type: "FUNCTIONAL", title: "t", statement: "s" },
        FAKE_ID,
      ),
    "VALIDATION_ERROR",
  );
});

test("createRequirementService rejects an invalid requirement_type", async () => {
  await expectHttpError(
    () =>
      createRequirementService(
        FAKE_ID,
        { requirement_code: "R-1", requirement_type: "BOGUS", title: "t", statement: "s" },
        FAKE_ID,
      ),
    "VALIDATION_ERROR",
  );
});

test("updateRequirementService rejects a non-UUID requirement id", async () => {
  await expectHttpError(
    () =>
      updateRequirementService(
        "not-a-uuid",
        { title: "t", statement: "s", lifecycle_status: "DRAFT" },
        FAKE_ID,
      ),
    "VALIDATION_ERROR",
  );
});

test("updateRequirementService rejects an invalid lifecycle_status", async () => {
  await expectHttpError(
    () => updateRequirementService(FAKE_ID, { title: "t", statement: "s", lifecycle_status: "DONE" }, FAKE_ID),
    "VALIDATION_ERROR",
  );
});

test("splitRequirementService rejects a non-UUID parent id", async () => {
  await expectHttpError(
    () =>
      splitRequirementService(
        "not-a-uuid",
        { requirement_code: "R-2", requirement_type: "FUNCTIONAL", title: "t", statement: "s" },
        FAKE_ID,
      ),
    "VALIDATION_ERROR",
  );
});

// --- Acceptance Criteria ---
// Note: createAcService/createRuleService/createStepService/
// createTransitionService/createAttributeService all look up their
// parent record (requirement/rule/workflow/data definition) via a
// real DB query *before* validating the rest of the body - so these
// tests use a non-UUID parent id to fail at the UUID-format check
// (no DB query reached) rather than a UUID that would reach the
// lookup and require a live database connection.

test("createAcService rejects a non-UUID requirement id", async () => {
  await expectHttpError(
    () =>
      createAcService(
        "not-a-uuid",
        { ac_code: "AC-1", condition_text: "c", expected_outcome: "o" },
        FAKE_ID,
      ),
    "VALIDATION_ERROR",
  );
});

test("updateAcService rejects a non-UUID ac id", async () => {
  await expectHttpError(
    () =>
      updateAcService(
        "not-a-uuid",
        { condition_text: "c", expected_outcome: "o", status: "DRAFT" },
        FAKE_ID,
      ),
    "VALIDATION_ERROR",
  );
});

// --- Business Rule ---

test("createRuleService rejects a non-UUID case id", async () => {
  await expectHttpError(
    () => createRuleService("not-a-uuid", { rule_code: "BR-1", rule_statement: "s", rule_type: "CONSTRAINT" }, FAKE_ID),
    "VALIDATION_ERROR",
  );
});

test("updateRuleService rejects a non-UUID rule id", async () => {
  await expectHttpError(
    () => updateRuleService("not-a-uuid", { rule_statement: "s", status: "DRAFT" }, FAKE_ID),
    "VALIDATION_ERROR",
  );
});

// --- Workflow ---

test("createWorkflowService rejects a non-UUID case id", async () => {
  await expectHttpError(
    () => createWorkflowService("not-a-uuid", { workflow_code: "W-1", workflow_name: "n" }, FAKE_ID),
    "VALIDATION_ERROR",
  );
});

test("createStepService rejects a non-UUID workflow id", async () => {
  await expectHttpError(
    () =>
      createStepService(
        "not-a-uuid",
        { step_key: "s1", step_name: "n", step_type: "TASK" },
        FAKE_ID,
      ),
    "VALIDATION_ERROR",
  );
});

test("createTransitionService rejects a non-UUID workflow id", async () => {
  await expectHttpError(
    () =>
      createTransitionService(
        "not-a-uuid",
        { source_step_id: FAKE_ID, target_step_id: FAKE_ID, transition_key: "t1" },
        FAKE_ID,
      ),
    "VALIDATION_ERROR",
  );
});

// --- Business Data Definition ---

test("createDataDefinitionService rejects a non-UUID case id", async () => {
  await expectHttpError(
    () =>
      createDataDefinitionService(
        "not-a-uuid",
        { data_code: "D-1", entity_name: "n", business_meaning: "m", data_kind: "ENTITY" },
        FAKE_ID,
      ),
    "VALIDATION_ERROR",
  );
});

test("createAttributeService rejects a non-UUID data definition id", async () => {
  await expectHttpError(
    () =>
      createAttributeService(
        "not-a-uuid",
        { attribute_code: "A-1", attribute_name: "n", business_type: "string", nullable_policy: "REQUIRED" },
        FAKE_ID,
      ),
    "VALIDATION_ERROR",
  );
});
