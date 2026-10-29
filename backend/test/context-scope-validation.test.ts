// Validation-only tests for Context and Scope services - same
// reasoning as cases-service-validation.test.ts: every assertion
// here throws before opening a transaction, so no database
// connection or credentials are needed to run this file.

import { test } from "node:test";
import assert from "node:assert/strict";
import { HttpError } from "../src/http/errors.js";
import { createContextService, listContextsService, updateContextService } from "../src/modules/context/service.js";
import { putScopeService } from "../src/modules/scope/service.js";

const FAKE_USER_ID = "00000000-0000-0000-0000-000000000001";
const FAKE_CASE_ID = "00000000-0000-0000-0000-000000000002";

async function expectHttpError(fn: () => Promise<unknown>, code: string): Promise<void> {
  try {
    await fn();
    assert.fail("expected an HttpError to be thrown");
  } catch (err) {
    assert.ok(err instanceof HttpError, "expected HttpError, got: " + String(err));
    assert.equal(err.code, code);
  }
}

test("listContextsService rejects a non-UUID case id", async () => {
  await expectHttpError(() => listContextsService("not-a-uuid"), "VALIDATION_ERROR");
});

test("createContextService rejects a missing context_type", async () => {
  await expectHttpError(
    () =>
      createContextService(
        FAKE_CASE_ID,
        { content: "x", knowledge_status: "KNOWN" },
        FAKE_USER_ID,
      ),
    "VALIDATION_ERROR",
  );
});

test("createContextService rejects an invalid knowledge_status", async () => {
  await expectHttpError(
    () =>
      createContextService(
        FAKE_CASE_ID,
        { context_type: "PROBLEM", content: "x", knowledge_status: "MAYBE" },
        FAKE_USER_ID,
      ),
    "VALIDATION_ERROR",
  );
});

test("createContextService rejects a malformed source_entity_id", async () => {
  await expectHttpError(
    () =>
      createContextService(
        FAKE_CASE_ID,
        { context_type: "PROBLEM", content: "x", knowledge_status: "KNOWN", source_entity_id: "nope" },
        FAKE_USER_ID,
      ),
    "VALIDATION_ERROR",
  );
});

test("updateContextService rejects a non-UUID context id", async () => {
  await expectHttpError(
    () => updateContextService("not-a-uuid", { content: "x", knowledge_status: "KNOWN" }, FAKE_USER_ID),
    "VALIDATION_ERROR",
  );
});

test("putScopeService rejects a missing scope_name", async () => {
  await expectHttpError(
    () => putScopeService(FAKE_CASE_ID, { in_scope: "x" }, FAKE_USER_ID),
    "VALIDATION_ERROR",
  );
});

test("putScopeService rejects a missing in_scope", async () => {
  await expectHttpError(
    () => putScopeService(FAKE_CASE_ID, { scope_name: "x" }, FAKE_USER_ID),
    "VALIDATION_ERROR",
  );
});

test("putScopeService rejects a non-array constraints_json", async () => {
  await expectHttpError(
    () =>
      putScopeService(
        FAKE_CASE_ID,
        { scope_name: "x", in_scope: "y", constraints_json: "not-an-array" },
        FAKE_USER_ID,
      ),
    "VALIDATION_ERROR",
  );
});
