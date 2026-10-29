// Validation-only tests for the Issue + IssueResolution module
// (Blocker Management, Phase 6 Quality & Completeness Core).

import { test } from "node:test";
import assert from "node:assert/strict";
import { HttpError } from "../src/http/errors.js";
import {
  createIssueService,
  getIssueService,
  listIssuesService,
  resolveIssueService,
  updateIssueService,
} from "../src/modules/issues/service.js";

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

test("listIssuesService rejects a non-UUID case id", async () => {
  await expectHttpError(() => listIssuesService("not-a-uuid"), "VALIDATION_ERROR");
});

test("listIssuesService rejects an invalid status filter", async () => {
  await expectHttpError(() => listIssuesService(FAKE_ID, "BOGUS"), "VALIDATION_ERROR");
});

test("getIssueService rejects a non-UUID issue id", async () => {
  await expectHttpError(() => getIssueService("not-a-uuid"), "VALIDATION_ERROR");
});

test("createIssueService rejects a non-UUID case id", async () => {
  await expectHttpError(
    () => createIssueService("not-a-uuid", { issue_code: "X", issue_subject: "s", issue_type: "BLOCKER" }, FAKE_ID),
    "VALIDATION_ERROR",
  );
});

test("createIssueService rejects an invalid issue_type", async () => {
  await expectHttpError(
    () => createIssueService(FAKE_ID, { issue_code: "X", issue_subject: "s", issue_type: "BOGUS" }, FAKE_ID),
    "VALIDATION_ERROR",
  );
});

test("updateIssueService rejects a non-UUID issue id", async () => {
  await expectHttpError(
    () => updateIssueService("not-a-uuid", { issue_subject: "s", issue_status: "OPEN" }, FAKE_ID),
    "VALIDATION_ERROR",
  );
});

test("updateIssueService rejects an invalid issue_status", async () => {
  await expectHttpError(
    () => updateIssueService(FAKE_ID, { issue_subject: "s", issue_status: "BOGUS" }, FAKE_ID),
    "VALIDATION_ERROR",
  );
});

test("resolveIssueService rejects a non-UUID issue id", async () => {
  await expectHttpError(
    () =>
      resolveIssueService(
        "not-a-uuid",
        { resolution_method: "m", resolution_summary: "s", verification_outcome: "PASS" },
        FAKE_ID,
      ),
    "VALIDATION_ERROR",
  );
});
