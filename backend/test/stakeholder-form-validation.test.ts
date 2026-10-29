// Validation-only tests for Stakeholder, Case Stakeholder/Role/
// Authority, Form/Version/Grant, and Form Response services -
// every assertion here throws before any database query runs.

import { test } from "node:test";
import assert from "node:assert/strict";
import { HttpError } from "../src/http/errors.js";
import { createStakeholderService, getStakeholderService } from "../src/modules/stakeholders/service.js";
import {
  addCaseStakeholderService,
  addRoleService,
  grantAuthorityService,
} from "../src/modules/case-stakeholders/service.js";
import {
  createFormService,
  createGrantService,
  createVersionService,
  updateVersionStatusService,
} from "../src/modules/forms/service.js";
import { getPublicFormService, submitFormResponseService } from "../src/modules/public-forms/service.js";
import { listResponsesService, updateResponseService } from "../src/modules/form-responses/service.js";

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

// --- Stakeholder (no DB call before validation) ---

test("createStakeholderService rejects a missing display_name", async () => {
  await expectHttpError(() => createStakeholderService({}), "VALIDATION_ERROR");
});

test("getStakeholderService rejects a non-UUID id", async () => {
  await expectHttpError(() => getStakeholderService("not-a-uuid"), "VALIDATION_ERROR");
});

// --- Case Stakeholder / Role / Authority ---
// addCaseStakeholderService/addRoleService/grantAuthorityService all
// look up a parent record via DB before validating further fields,
// so these use a non-UUID id to fail at the format check instead.

test("addCaseStakeholderService rejects a non-UUID case id", async () => {
  await expectHttpError(
    () => addCaseStakeholderService("not-a-uuid", { stakeholder_id: FAKE_ID, role_code: "BA" }, FAKE_ID),
    "VALIDATION_ERROR",
  );
});

test("addCaseStakeholderService rejects a non-UUID stakeholder_id", async () => {
  await expectHttpError(
    () => addCaseStakeholderService(FAKE_ID, { stakeholder_id: "not-a-uuid", role_code: "BA" }, FAKE_ID),
    "VALIDATION_ERROR",
  );
});

test("addRoleService rejects a non-UUID case_stakeholder_id", async () => {
  await expectHttpError(
    () => addRoleService("not-a-uuid", { role_code: "BA" }, FAKE_ID),
    "VALIDATION_ERROR",
  );
});

test("grantAuthorityService rejects a non-UUID case_stakeholder_id", async () => {
  await expectHttpError(
    () =>
      grantAuthorityService(
        "not-a-uuid",
        { authority_type: "BUSINESS_CONFIRM", permitted_action: "confirm" },
        FAKE_ID,
      ),
    "VALIDATION_ERROR",
  );
});

// --- Forms ---

test("createFormService rejects a non-UUID case id", async () => {
  await expectHttpError(
    () => createFormService("not-a-uuid", { form_name: "x" }, FAKE_ID),
    "VALIDATION_ERROR",
  );
});

test("createVersionService rejects a non-UUID form id", async () => {
  await expectHttpError(
    () =>
      createVersionService("not-a-uuid", {
        questions: [{ item_key: "q1", prompt_label: "p", answer_type: "TEXT" }],
      }),
    "VALIDATION_ERROR",
  );
});

test("updateVersionStatusService rejects a non-UUID version id", async () => {
  await expectHttpError(
    () => updateVersionStatusService("not-a-uuid", { publication_status: "OPEN" }),
    "VALIDATION_ERROR",
  );
});

test("updateVersionStatusService rejects an invalid publication_status", async () => {
  await expectHttpError(
    () => updateVersionStatusService(FAKE_ID, { publication_status: "BOGUS" }),
    "VALIDATION_ERROR",
  );
});

test("createGrantService rejects a non-UUID form_version_id", async () => {
  await expectHttpError(
    () => createGrantService("not-a-uuid", {}),
    "VALIDATION_ERROR",
  );
});

// --- Public Forms (no DB call before the token-format check) ---

test("getPublicFormService rejects an empty token", async () => {
  await expectHttpError(() => getPublicFormService(""), "VALIDATION_ERROR");
});

test("submitFormResponseService rejects an empty token", async () => {
  await expectHttpError(
    () => submitFormResponseService("", { answers: [{ form_item_id: FAKE_ID, answer_value: "x" }] }),
    "VALIDATION_ERROR",
  );
});

// --- Form Responses ---

test("listResponsesService rejects a non-UUID case id", async () => {
  await expectHttpError(
    () => listResponsesService("not-a-uuid", {}),
    "VALIDATION_ERROR",
  );
});

test("listResponsesService rejects an invalid status filter", async () => {
  await expectHttpError(
    () => listResponsesService(FAKE_ID, { status: "BOGUS" }),
    "VALIDATION_ERROR",
  );
});

test("updateResponseService rejects a non-UUID response id", async () => {
  await expectHttpError(
    () => updateResponseService("not-a-uuid", { review_status: "REVIEWED" }),
    "VALIDATION_ERROR",
  );
});

test("updateResponseService rejects an invalid review_status", async () => {
  await expectHttpError(
    () => updateResponseService(FAKE_ID, { review_status: "BOGUS" }),
    "VALIDATION_ERROR",
  );
});
