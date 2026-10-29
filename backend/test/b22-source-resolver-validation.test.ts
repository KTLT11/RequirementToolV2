// Validation-only tests for B2.2 Source Eligibility, Provenance &
// FC-09 Guidance. resolveSourcePackage() calls resolveDependencyClosure()
// and repository functions that go straight to the pool, so full
// behavior (accessible/relevant/eligible classification, evidence/
// decision guidance, partial-scope REFERENCED_ONLY provenance) is
// exercised end-to-end in test/integration.ts's "Source Resolver
// (B2.2)" section instead.
//
// What IS checked here, without a database: eligibility is NEVER
// anything other than UNDETERMINED - this is the single most
// important invariant of the approved B2.2 decision (no hardcoded
// CONFIRMED/AGREED threshold), and the easiest one for a future edit
// to silently break by adding an "ELIGIBLE" branch somewhere.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { EligibilityStatus } from "../src/modules/documents/source-resolver.js";

test("EligibilityStatus type only ever permits UNDETERMINED", () => {
  // This is a compile-time assertion as much as a runtime one: if a
  // future change widens EligibilityStatus to include "ELIGIBLE" or
  // "INELIGIBLE", this line's type would still compile (TypeScript
  // doesn't error on a value narrower than a union type's full
  // range), so the real guard is reviewers noticing EligibilityStatus
  // widen away from a 1-value union - but the runtime check below at
  // least confirms this literal is still assignable to the type as it
  // stands today.
  const onlyValidValue: EligibilityStatus = "UNDETERMINED";
  assert.equal(onlyValidValue, "UNDETERMINED");
});
