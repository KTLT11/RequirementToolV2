// Validation-only tests for the P2-D Structural Validation module.

import { test } from "node:test";
import assert from "node:assert/strict";
import { HttpError } from "../src/http/errors.js";
import {
  createValidationRunService,
  getValidationRunService,
  listValidationRunsService,
  recordHumanReviewedResultService,
} from "../src/modules/validation/service.js";

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

test("createValidationRunService rejects a non-UUID case id", async () => {
  await expectHttpError(() => createValidationRunService("not-a-uuid", FAKE_ID), "VALIDATION_ERROR");
});

test("listValidationRunsService rejects a non-UUID case id", async () => {
  await expectHttpError(() => listValidationRunsService("not-a-uuid"), "VALIDATION_ERROR");
});

test("getValidationRunService rejects a non-UUID validation_run_id", async () => {
  await expectHttpError(() => getValidationRunService("not-a-uuid"), "VALIDATION_ERROR");
});

test("recordHumanReviewedResultService rejects a non-UUID validation_run_id", async () => {
  await expectHttpError(
    () =>
      recordHumanReviewedResultService(
        "not-a-uuid",
        { check_rule_code: "X", result_outcome: "PASS", finding_summary: "basis" },
        FAKE_ID,
      ),
    "VALIDATION_ERROR",
  );
});
