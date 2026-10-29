// Validation-only tests for B1.1 Exact Revision Read Access (CI-01).
// Cases that need a real database (exact lookup, not-found, revision/
// entity mismatch) live in test/integration.ts instead, since these
// checks run before any DB query and fail on bad input alone.

import { test } from "node:test";
import assert from "node:assert/strict";
import { HttpError } from "../src/http/errors.js";
import {
  getEntityRevisionService,
  getRelationRevisionService,
} from "../src/modules/entities/service.js";

const FAKE_ENTITY_ID = "00000000-0000-0000-0000-000000000005";
const FAKE_REVISION_ID = "00000000-0000-0000-0000-000000000006";

async function expectHttpError(fn: () => Promise<unknown>, code: string): Promise<void> {
  try {
    await fn();
    assert.fail("expected an HttpError to be thrown");
  } catch (err) {
    assert.ok(err instanceof HttpError, "expected HttpError, got: " + String(err));
    assert.equal(err.code, code);
  }
}

test("getEntityRevisionService rejects a non-UUID entity_id", async () => {
  await expectHttpError(
    () => getEntityRevisionService("not-a-uuid", { revision_no: 1 }),
    "VALIDATION_ERROR",
  );
});

test("getEntityRevisionService rejects when neither revision_id nor revision_no is given", async () => {
  await expectHttpError(() => getEntityRevisionService(FAKE_ENTITY_ID, {}), "VALIDATION_ERROR");
});

test("getEntityRevisionService rejects when both revision_id and revision_no are given", async () => {
  await expectHttpError(
    () =>
      getEntityRevisionService(FAKE_ENTITY_ID, {
        revision_id: FAKE_REVISION_ID,
        revision_no: 1,
      }),
    "VALIDATION_ERROR",
  );
});

test("getEntityRevisionService rejects a non-UUID revision_id", async () => {
  await expectHttpError(
    () => getEntityRevisionService(FAKE_ENTITY_ID, { revision_id: "not-a-uuid" }),
    "VALIDATION_ERROR",
  );
});

test("getEntityRevisionService rejects a non-positive-integer revision_no", async () => {
  await expectHttpError(
    () => getEntityRevisionService(FAKE_ENTITY_ID, { revision_no: 0 }),
    "VALIDATION_ERROR",
  );
  await expectHttpError(
    () => getEntityRevisionService(FAKE_ENTITY_ID, { revision_no: -1 }),
    "VALIDATION_ERROR",
  );
  await expectHttpError(
    () => getEntityRevisionService(FAKE_ENTITY_ID, { revision_no: 1.5 }),
    "VALIDATION_ERROR",
  );
  await expectHttpError(
    () => getEntityRevisionService(FAKE_ENTITY_ID, { revision_no: "1" as unknown }),
    "VALIDATION_ERROR",
  );
});

test("getRelationRevisionService rejects a non-UUID relation_id", async () => {
  await expectHttpError(
    () => getRelationRevisionService("not-a-uuid", { revision_no: 1 }),
    "VALIDATION_ERROR",
  );
});

test("getRelationRevisionService rejects when neither revision_id nor revision_no is given", async () => {
  await expectHttpError(() => getRelationRevisionService(FAKE_ENTITY_ID, {}), "VALIDATION_ERROR");
});

test("getRelationRevisionService rejects when both revision_id and revision_no are given", async () => {
  await expectHttpError(
    () =>
      getRelationRevisionService(FAKE_ENTITY_ID, {
        revision_id: FAKE_REVISION_ID,
        revision_no: 1,
      }),
    "VALIDATION_ERROR",
  );
});

test("getRelationRevisionService rejects a non-UUID revision_id", async () => {
  await expectHttpError(
    () => getRelationRevisionService(FAKE_ENTITY_ID, { revision_id: "not-a-uuid" }),
    "VALIDATION_ERROR",
  );
});
