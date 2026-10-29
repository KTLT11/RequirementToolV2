// Validation-only tests for Customer Confirmation / ConfirmationScopeItem
// (Phase 6 P3 Step 5).

import { test } from "node:test";
import assert from "node:assert/strict";
import { HttpError } from "../src/http/errors.js";
import {
  createConfirmationService,
  getConfirmationService,
  listConfirmationsByPublicationService,
} from "../src/modules/confirmations/service.js";

const FAKE_ID = "00000000-0000-0000-0000-000000000003";
const FAKE_ID_2 = "00000000-0000-0000-0000-000000000004";

async function expectHttpError(fn: () => Promise<unknown>, code: string): Promise<void> {
  try {
    await fn();
    assert.fail("expected an HttpError to be thrown");
  } catch (err) {
    assert.ok(err instanceof HttpError, "expected HttpError, got: " + String(err));
    assert.equal(err.code, code);
  }
}

test("createConfirmationService rejects a non-UUID publication id", async () => {
  await expectHttpError(
    () =>
      createConfirmationService(
        "not-a-uuid",
        {
          signer_stakeholder_id: FAKE_ID,
          signer_authority_id: FAKE_ID_2,
          confirmation_outcome: "CONFIRMED",
          confirmation_basis: "basis",
        },
        FAKE_ID,
      ),
    "VALIDATION_ERROR",
  );
});

test("createConfirmationService rejects a missing signer_authority_id", async () => {
  await expectHttpError(
    () =>
      createConfirmationService(
        FAKE_ID,
        {
          signer_stakeholder_id: FAKE_ID,
          confirmation_outcome: "CONFIRMED",
          confirmation_basis: "basis",
        },
        FAKE_ID,
      ),
    "VALIDATION_ERROR",
  );
});

test("createConfirmationService rejects an invalid confirmation_outcome", async () => {
  await expectHttpError(
    () =>
      createConfirmationService(
        FAKE_ID,
        {
          signer_stakeholder_id: FAKE_ID,
          signer_authority_id: FAKE_ID_2,
          confirmation_outcome: "BOGUS",
          confirmation_basis: "basis",
        },
        FAKE_ID,
      ),
    "VALIDATION_ERROR",
  );
});

test("createConfirmationService requires scope_items when outcome is PARTIAL", async () => {
  await expectHttpError(
    () =>
      createConfirmationService(
        FAKE_ID,
        {
          signer_stakeholder_id: FAKE_ID,
          signer_authority_id: FAKE_ID_2,
          confirmation_outcome: "PARTIAL",
          confirmation_basis: "basis",
        },
        FAKE_ID,
      ),
    "VALIDATION_ERROR",
  );
});

test("getConfirmationService rejects a non-UUID confirmation id", async () => {
  await expectHttpError(() => getConfirmationService("not-a-uuid"), "VALIDATION_ERROR");
});

test("listConfirmationsByPublicationService rejects a non-UUID publication id", async () => {
  await expectHttpError(() => listConfirmationsByPublicationService("not-a-uuid"), "VALIDATION_ERROR");
});
