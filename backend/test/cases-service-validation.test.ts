// Validation-only tests - every case here throws before the service
// ever opens a transaction, so these run without a database
// connection and without any real credentials. Behavior that
// requires a live transaction (success path, rollback-on-conflict)
// is covered separately in test/cases-integration.manual.ts, which
// is NOT run by this automated suite.

import { test } from "node:test";
import assert from "node:assert/strict";
import { HttpError } from "../src/http/errors.js";
import {
  createCaseService,
  getCaseService,
  listCasesService,
  updateCaseService,
} from "../src/modules/cases/service.js";

const FAKE_USER_ID = "00000000-0000-0000-0000-000000000001";

async function expectHttpError(
  fn: () => Promise<unknown>,
  code: string,
): Promise<void> {
  try {
    await fn();
    assert.fail("expected an HttpError to be thrown");
  } catch (err) {
    assert.ok(err instanceof HttpError, "expected HttpError, got: " + String(err));
    assert.equal(err.code, code);
  }
}

test("listCasesService rejects a non-positive page", async () => {
  await expectHttpError(
    () => listCasesService({ page: "0" }),
    "VALIDATION_ERROR",
  );
});

test("listCasesService rejects a pageSize over the max", async () => {
  await expectHttpError(
    () => listCasesService({ pageSize: "101" }),
    "VALIDATION_ERROR",
  );
});

test("getCaseService rejects a non-UUID case id", async () => {
  await expectHttpError(() => getCaseService("not-a-uuid"), "VALIDATION_ERROR");
});

test("createCaseService rejects a missing case_code", async () => {
  await expectHttpError(
    () =>
      createCaseService(
        {
          case_name: "Name",
          incoming_request: {
            request_code: "R1",
            request_text: "text",
            source_type: "EMAIL",
          },
        },
        FAKE_USER_ID,
      ),
    "VALIDATION_ERROR",
  );
});

test("createCaseService rejects a missing incoming_request", async () => {
  await expectHttpError(
    () => createCaseService({ case_code: "C1", case_name: "Name" }, FAKE_USER_ID),
    "VALIDATION_ERROR",
  );
});

test("createCaseService rejects an unparseable received_at", async () => {
  await expectHttpError(
    () =>
      createCaseService(
        {
          case_code: "C1",
          case_name: "Name",
          incoming_request: {
            request_code: "R1",
            request_text: "text",
            source_type: "EMAIL",
            received_at: "not-a-date",
          },
        },
        FAKE_USER_ID,
      ),
    "VALIDATION_ERROR",
  );
});

test("updateCaseService rejects a non-UUID case id", async () => {
  await expectHttpError(
    () => updateCaseService("not-a-uuid", { case_name: "New name" }, FAKE_USER_ID),
    "VALIDATION_ERROR",
  );
});

test("updateCaseService rejects an empty case_name", async () => {
  await expectHttpError(
    () =>
      updateCaseService(
        "00000000-0000-0000-0000-000000000099",
        { case_name: "   " },
        FAKE_USER_ID,
      ),
    "VALIDATION_ERROR",
  );
});
