// Validation-only tests for B2.1 Dependency Closure. resolveDependencyClosure
// itself calls traceability/repository.ts and validation/repository.ts
// functions that go straight to the pool (no injectable client), so it
// cannot be unit-tested without a live database - the full traversal
// (multi-hop, cycle/duplicate handling, exact revision pinning, error
// paths) is exercised end-to-end in test/integration.ts's "Dependency
// Closure (B2.1)" section instead.
//
// What IS checked here, without a database: the exported relation-type
// allowlist is exactly the 4 types the approved B2.1 contract names -
// no more, no fewer - since accidentally adding or dropping one of
// these constants would silently change which relationships
// participate in every closure computation.

import { test } from "node:test";
import assert from "node:assert/strict";
import { DEPENDENCY_RELATION_TYPES } from "../src/modules/documents/dependency-closure.js";

test("DEPENDENCY_RELATION_TYPES is exactly the 4 approved relation types", () => {
  assert.deepEqual(
    [...DEPENDENCY_RELATION_TYPES].sort(),
    [
      "DECISION_SUPPORTS_RULE",
      "REQUIREMENT_FOLLOWS_WORKFLOW",
      "RULE_APPLIES_TO_REQUIREMENT",
      "RULE_REFERENCES_DATA_DEFINITION",
    ].sort(),
  );
});

test("DEPENDENCY_RELATION_TYPES does not include the deferred relation types", () => {
  // REQUIREMENT_HAS_EXCEPTION_PATH and NFR_APPLIES_TO_REQUIREMENT are
  // explicitly not seeded (approved contract requirement #9) and must
  // never appear here even if seeded accidentally by future work
  // without updating this allowlist deliberately.
  assert.ok(!DEPENDENCY_RELATION_TYPES.includes("REQUIREMENT_HAS_EXCEPTION_PATH" as never));
  assert.ok(!DEPENDENCY_RELATION_TYPES.includes("NFR_APPLIES_TO_REQUIREMENT" as never));
});

test("DEPENDENCY_RELATION_TYPES does not include pre-existing relation types outside B1.2 scope", () => {
  // DECOMPOSED_FROM, EVIDENCE_SUPPORTS_DECISION and DECISION_SUPPORTS_
  // REQUIREMENT existed before B1.2/B2.1 and deliberately do not
  // participate in dependency closure traversal per the approved
  // contract's Requirement #3.
  for (const preExisting of [
    "DECOMPOSED_FROM",
    "EVIDENCE_SUPPORTS_DECISION",
    "DECISION_SUPPORTS_REQUIREMENT",
  ]) {
    assert.ok(!DEPENDENCY_RELATION_TYPES.includes(preExisting as never));
  }
});
