// Validation-only tests for Evidence and Business Decision services.

import { test } from "node:test";
import assert from "node:assert/strict";
import { HttpError } from "../src/http/errors.js";
import {
  confirmEvidenceService,
  createEvidenceService,
  reviewEvidenceService,
} from "../src/modules/evidence/service.js";
import { createDecisionService, updateDecisionService } from "../src/modules/business-decisions/service.js";

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

test("createEvidenceService rejects a non-UUID case id", async () => {
  await expectHttpError(
    () => createEvidenceService("not-a-uuid", { assertion_text: "x", source_kind: "BA" }, FAKE_ID),
    "VALIDATION_ERROR",
  );
});

test("createEvidenceService rejects an invalid source_kind", async () => {
  await expectHttpError(
    () => createEvidenceService(FAKE_ID, { assertion_text: "x", source_kind: "BOGUS" }, FAKE_ID),
    "VALIDATION_ERROR",
  );
});

// reviewEvidenceService/confirmEvidenceService look up the evidence
// row via DB before validating further fields - use a non-UUID
// evidence id to fail at the format check instead.

test("reviewEvidenceService rejects a non-UUID evidence id", async () => {
  await expectHttpError(
    () => reviewEvidenceService("not-a-uuid", { review_outcome: "REVIEWED", review_basis: "x" }, FAKE_ID),
    "VALIDATION_ERROR",
  );
});

test("confirmEvidenceService rejects a non-UUID evidence id", async () => {
  await expectHttpError(
    () =>
      confirmEvidenceService(
        "not-a-uuid",
        { confirmation_outcome: "CONFIRMED", evidence_basis: "x", authority_id: FAKE_ID },
        FAKE_ID,
      ),
    "VALIDATION_ERROR",
  );
});

test("createDecisionService rejects a non-UUID case id", async () => {
  await expectHttpError(
    () =>
      createDecisionService(
        "not-a-uuid",
        { decision_subject: "s", decision_text: "t", decision_outcome: "PROPOSED" },
        FAKE_ID,
      ),
    "VALIDATION_ERROR",
  );
});

test("createDecisionService rejects an invalid decision_outcome", async () => {
  await expectHttpError(
    () =>
      createDecisionService(
        FAKE_ID,
        { decision_subject: "s", decision_text: "t", decision_outcome: "BOGUS" },
        FAKE_ID,
      ),
    "VALIDATION_ERROR",
  );
});

test("createDecisionService rejects effective_to before effective_from", async () => {
  await expectHttpError(
    () =>
      createDecisionService(
        FAKE_ID,
        {
          decision_subject: "s",
          decision_text: "t",
          decision_outcome: "PROPOSED",
          effective_from: "2026-06-01T00:00:00Z",
          effective_to: "2026-01-01T00:00:00Z",
        },
        FAKE_ID,
      ),
    "VALIDATION_ERROR",
  );
});

test("updateDecisionService rejects a non-UUID decision id", async () => {
  await expectHttpError(
    () => updateDecisionService("not-a-uuid", { decision_text: "t", decision_outcome: "AGREED" }, FAKE_ID),
    "VALIDATION_ERROR",
  );
});
