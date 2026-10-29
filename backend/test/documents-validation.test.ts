// Validation-only tests for the Document/Snapshot/Publication module
// (Phase 6 P3 — Document Infrastructure).

import { test } from "node:test";
import assert from "node:assert/strict";
import { HttpError } from "../src/http/errors.js";
import {
  createDocumentService,
  createPublicationService,
  createSnapshotService,
  getDocumentService,
  getPublicationService,
  getSnapshotService,
  invalidateSnapshotService,
  listDocumentsService,
  updatePublicationStatusService,
} from "../src/modules/documents/service.js";

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

test("listDocumentsService rejects a non-UUID case id", async () => {
  await expectHttpError(() => listDocumentsService("not-a-uuid"), "VALIDATION_ERROR");
});

test("getDocumentService rejects a non-UUID document id", async () => {
  await expectHttpError(() => getDocumentService("not-a-uuid"), "VALIDATION_ERROR");
});

test("createDocumentService rejects a non-UUID case id", async () => {
  await expectHttpError(
    () => createDocumentService("not-a-uuid", { document_type: "CRD", document_name: "x" }, FAKE_ID),
    "VALIDATION_ERROR",
  );
});

test("createDocumentService rejects an invalid document_type", async () => {
  await expectHttpError(
    () => createDocumentService(FAKE_ID, { document_type: "BOGUS", document_name: "x" }, FAKE_ID),
    "VALIDATION_ERROR",
  );
});

test("createDocumentService rejects a missing document_name", async () => {
  await expectHttpError(
    () => createDocumentService(FAKE_ID, { document_type: "CRD" }, FAKE_ID),
    "VALIDATION_ERROR",
  );
});

test("createSnapshotService rejects a non-UUID document id", async () => {
  await expectHttpError(
    () =>
      createSnapshotService(
        "not-a-uuid",
        { content: { a: 1 }, scope_entity_ids: [FAKE_ID] },
        FAKE_ID,
      ),
    "VALIDATION_ERROR",
  );
});

test("getSnapshotService rejects a non-UUID snapshot id", async () => {
  await expectHttpError(() => getSnapshotService("not-a-uuid"), "VALIDATION_ERROR");
});

test("invalidateSnapshotService rejects a non-UUID snapshot id", async () => {
  await expectHttpError(() => invalidateSnapshotService("not-a-uuid", {}), "VALIDATION_ERROR");
});

test("createPublicationService rejects a non-UUID snapshot id", async () => {
  await expectHttpError(
    () =>
      createPublicationService(
        "not-a-uuid",
        { publication_purpose: "CUSTOMER_REVIEW", recipient_scope: "x" },
        FAKE_ID,
      ),
    "VALIDATION_ERROR",
  );
});

test("getPublicationService rejects a non-UUID publication id", async () => {
  await expectHttpError(() => getPublicationService("not-a-uuid"), "VALIDATION_ERROR");
});

test("updatePublicationStatusService rejects a non-UUID publication id", async () => {
  await expectHttpError(
    () => updatePublicationStatusService("not-a-uuid", { publication_status: "WITHDRAWN" }),
    "VALIDATION_ERROR",
  );
});

test("updatePublicationStatusService rejects an invalid publication_status", async () => {
  await expectHttpError(
    () => updatePublicationStatusService(FAKE_ID, { publication_status: "BOGUS" }),
    "VALIDATION_ERROR",
  );
});
