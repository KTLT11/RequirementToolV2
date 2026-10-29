// Validation-only tests for Module Application, Discovery Answer,
// and Information Gap services - every assertion here throws before
// any database query runs, so no connection or credentials are
// needed.

import { test } from "node:test";
import assert from "node:assert/strict";
import { HttpError } from "../src/http/errors.js";
import {
  listModuleApplicationsService,
  updateModuleApplicationService,
} from "../src/modules/module-applications/service.js";
import { createAnswerService, updateAnswerService } from "../src/modules/discovery-answers/service.js";
import { createGapService, listGapsService, updateGapService } from "../src/modules/information-gaps/service.js";

const FAKE_CASE_ID = "00000000-0000-0000-0000-000000000002";
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

test("listModuleApplicationsService rejects a non-UUID case id", async () => {
  await expectHttpError(() => listModuleApplicationsService("not-a-uuid"), "VALIDATION_ERROR");
});

test("updateModuleApplicationService rejects an invalid application_status", async () => {
  await expectHttpError(
    () => updateModuleApplicationService(FAKE_ID, { application_status: "PAUSED" }),
    "VALIDATION_ERROR",
  );
});

test("createAnswerService rejects a missing question_definition_version_id", async () => {
  await expectHttpError(
    () => createAnswerService(FAKE_CASE_ID, { answer_status: "KNOWN" }, FAKE_ID),
    "VALIDATION_ERROR",
  );
});

test("createAnswerService rejects an invalid answer_status", async () => {
  await expectHttpError(
    () =>
      createAnswerService(
        FAKE_CASE_ID,
        { question_definition_version_id: FAKE_ID, answer_status: "MAYBE" },
        FAKE_ID,
      ),
    "VALIDATION_ERROR",
  );
});

test("updateAnswerService rejects a non-UUID answer id", async () => {
  await expectHttpError(
    () => updateAnswerService("not-a-uuid", { answer_status: "KNOWN" }),
    "VALIDATION_ERROR",
  );
});

test("listGapsService rejects an invalid status filter", async () => {
  await expectHttpError(
    () => listGapsService(FAKE_CASE_ID, { status: "CLOSED" }),
    "VALIDATION_ERROR",
  );
});

test("createGapService rejects an invalid condition_type", async () => {
  await expectHttpError(
    () => createGapService(FAKE_CASE_ID, { condition_type: "TYPO", gap_summary: "x" }),
    "VALIDATION_ERROR",
  );
});

test("createGapService rejects a missing gap_summary", async () => {
  await expectHttpError(
    () => createGapService(FAKE_CASE_ID, { condition_type: "MISSING" }),
    "VALIDATION_ERROR",
  );
});

test("updateGapService rejects an invalid gap_status", async () => {
  await expectHttpError(
    () => updateGapService(FAKE_ID, { gap_status: "DONE" }),
    "VALIDATION_ERROR",
  );
});
