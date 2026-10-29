// Validation-only tests for HandoffBaseline + DevReviewRecord
// (Phase 6 P3 Steps 6-7).

import { test } from "node:test";
import assert from "node:assert/strict";
import { HttpError } from "../src/http/errors.js";
import {
  createDevReviewService,
  createHandoffService,
  getDevReviewService,
  getHandoffService,
  listHandoffsService,
  updateDevReviewService,
  updateHandoffStatusService,
} from "../src/modules/handoff/service.js";

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

test("createHandoffService rejects a non-UUID case id", async () => {
  await expectHttpError(
    () =>
      createHandoffService(
        "not-a-uuid",
        { readiness_assessment_id: FAKE_ID, publication_ids: [FAKE_ID], handoff_purpose: "DEV_IMPLEMENTATION" },
        FAKE_ID,
      ),
    "VALIDATION_ERROR",
  );
});

test("createHandoffService rejects an invalid handoff_purpose", async () => {
  await expectHttpError(
    () =>
      createHandoffService(
        FAKE_ID,
        { readiness_assessment_id: FAKE_ID, publication_ids: [FAKE_ID], handoff_purpose: "BOGUS" },
        FAKE_ID,
      ),
    "VALIDATION_ERROR",
  );
});

test("createHandoffService rejects a missing publication_ids", async () => {
  await expectHttpError(
    () =>
      createHandoffService(
        FAKE_ID,
        { readiness_assessment_id: FAKE_ID, handoff_purpose: "DEV_IMPLEMENTATION" },
        FAKE_ID,
      ),
    "VALIDATION_ERROR",
  );
});

test("getHandoffService rejects a non-UUID handoff id", async () => {
  await expectHttpError(() => getHandoffService("not-a-uuid"), "VALIDATION_ERROR");
});

test("listHandoffsService rejects a non-UUID case id", async () => {
  await expectHttpError(() => listHandoffsService("not-a-uuid"), "VALIDATION_ERROR");
});

test("updateHandoffStatusService rejects a non-UUID handoff id", async () => {
  await expectHttpError(
    () => updateHandoffStatusService("not-a-uuid", { baseline_status: "WITHDRAWN" }),
    "VALIDATION_ERROR",
  );
});

test("updateHandoffStatusService rejects an invalid baseline_status", async () => {
  await expectHttpError(
    () => updateHandoffStatusService(FAKE_ID, { baseline_status: "BOGUS" }),
    "VALIDATION_ERROR",
  );
});

test("createDevReviewService rejects a non-UUID handoff id", async () => {
  await expectHttpError(
    () =>
      createDevReviewService(
        "not-a-uuid",
        { reviewer_stakeholder_id: FAKE_ID, review_outcome: "PENDING" },
        FAKE_ID,
      ),
    "VALIDATION_ERROR",
  );
});

test("getDevReviewService rejects a non-UUID dev_review id", async () => {
  await expectHttpError(() => getDevReviewService("not-a-uuid"), "VALIDATION_ERROR");
});

test("updateDevReviewService rejects a non-UUID dev_review id", async () => {
  await expectHttpError(
    () => updateDevReviewService("not-a-uuid", { review_outcome: "ACCEPTED" }),
    "VALIDATION_ERROR",
  );
});
