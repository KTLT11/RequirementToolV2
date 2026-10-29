// Validation-only tests for the Assessment module (Completeness,
// Quality Gate, Readiness — Phase 6 Quality & Completeness Core).

import { test } from "node:test";
import assert from "node:assert/strict";
import { HttpError } from "../src/http/errors.js";
import {
  createCompletenessAssessmentService,
  createQualityAssessmentService,
  createReadinessAssessmentService,
  getAssessmentService,
  listAssessmentsService,
} from "../src/modules/assessment/service.js";

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

test("createCompletenessAssessmentService rejects a non-UUID case id", async () => {
  await expectHttpError(() => createCompletenessAssessmentService("not-a-uuid", FAKE_ID), "VALIDATION_ERROR");
});

test("createQualityAssessmentService rejects a non-UUID case id", async () => {
  await expectHttpError(() => createQualityAssessmentService("not-a-uuid", FAKE_ID), "VALIDATION_ERROR");
});

test("createReadinessAssessmentService rejects a non-UUID case id", async () => {
  await expectHttpError(() => createReadinessAssessmentService("not-a-uuid", FAKE_ID), "VALIDATION_ERROR");
});

test("listAssessmentsService rejects a non-UUID case id", async () => {
  await expectHttpError(() => listAssessmentsService("not-a-uuid"), "VALIDATION_ERROR");
});

test("listAssessmentsService rejects an invalid assessment_type filter", async () => {
  await expectHttpError(() => listAssessmentsService(FAKE_ID, "BOGUS"), "VALIDATION_ERROR");
});

test("getAssessmentService rejects a non-UUID assessment id", async () => {
  await expectHttpError(() => getAssessmentService("not-a-uuid"), "VALIDATION_ERROR");
});
