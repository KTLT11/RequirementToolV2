// Validation-only tests for the generic Traceability API.

import { test } from "node:test";
import assert from "node:assert/strict";
import { HttpError } from "../src/http/errors.js";
import { createRelationService, listRelationsForEntityService } from "../src/modules/traceability/service.js";

const FAKE_ID = "00000000-0000-0000-0000-000000000003";
const OTHER_FAKE_ID = "00000000-0000-0000-0000-000000000004";

async function expectHttpError(fn: () => Promise<unknown>, code: string): Promise<void> {
  try {
    await fn();
    assert.fail("expected an HttpError to be thrown");
  } catch (err) {
    assert.ok(err instanceof HttpError, "expected HttpError, got: " + String(err));
    assert.equal(err.code, code);
  }
}

test("createRelationService rejects a missing relation_type_code", async () => {
  await expectHttpError(
    () =>
      createRelationService(
        { source_entity_id: FAKE_ID, target_entity_id: OTHER_FAKE_ID },
        FAKE_ID,
      ),
    "VALIDATION_ERROR",
  );
});

test("createRelationService rejects a non-UUID source_entity_id", async () => {
  await expectHttpError(
    () =>
      createRelationService(
        {
          relation_type_code: "DECISION_SUPPORTS_REQUIREMENT",
          source_entity_id: "not-a-uuid",
          target_entity_id: OTHER_FAKE_ID,
        },
        FAKE_ID,
      ),
    "VALIDATION_ERROR",
  );
});

test("createRelationService rejects a non-UUID target_entity_id", async () => {
  await expectHttpError(
    () =>
      createRelationService(
        {
          relation_type_code: "DECISION_SUPPORTS_REQUIREMENT",
          source_entity_id: FAKE_ID,
          target_entity_id: "not-a-uuid",
        },
        FAKE_ID,
      ),
    "VALIDATION_ERROR",
  );
});

test("createRelationService rejects identical source and target ids", async () => {
  await expectHttpError(
    () =>
      createRelationService(
        {
          relation_type_code: "DECISION_SUPPORTS_REQUIREMENT",
          source_entity_id: FAKE_ID,
          target_entity_id: FAKE_ID,
        },
        FAKE_ID,
      ),
    "VALIDATION_ERROR",
  );
});

// listRelationsForEntityService validates the id format before any DB
// lookup, so a non-UUID id fails at that check without touching the DB.

test("listRelationsForEntityService rejects a non-UUID entity id", async () => {
  await expectHttpError(() => listRelationsForEntityService("not-a-uuid"), "VALIDATION_ERROR");
});
