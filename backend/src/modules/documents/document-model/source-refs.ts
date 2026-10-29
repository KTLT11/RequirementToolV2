// B3.2 — SourceRef construction, kept deliberately separate from
// source-resolver.ts's eligibility findings (see types.ts's SourceRef
// docblock for why). Builds the (entity_id, entity_revision_id,
// manifest_membership, relation_provenance) tuple a DocumentSection
// cites - never anything about Accessible/Relevant/Eligible.

import type { SourcePackageResult } from "../source-resolver.js";
import type { SourceRef } from "./types.js";

/**
 * Builds the full SourceRef index for a resolved source package:
 * every scope entity as INCLUDED/CONFIRMABLE (per confirmableEntityIds,
 * mirroring createSnapshotService's own membership_role rule exactly),
 * every closure entity as REFERENCED_ONLY, keyed by entity_id for
 * O(1) lookup when building individual sections.
 */
export function buildSourceRefIndex(
  pkg: SourcePackageResult,
  confirmableEntityIds: ReadonlySet<string>,
): Map<string, SourceRef> {
  const index = new Map<string, SourceRef>();

  for (const finding of pkg.scope) {
    if (finding.entity_revision_id === null) continue; // ERROR accessibility - no ref to build
    index.set(finding.entity_id, {
      entity_id: finding.entity_id,
      entity_type: finding.entity_type,
      entity_revision_id: finding.entity_revision_id,
      manifest_membership: confirmableEntityIds.has(finding.entity_id) ? "CONFIRMABLE" : "INCLUDED",
      relation_provenance: [],
    });
  }

  for (const finding of pkg.referenced_only) {
    if (finding.entity_revision_id === null) continue;
    index.set(finding.entity_id, {
      entity_id: finding.entity_id,
      entity_type: finding.entity_type,
      entity_revision_id: finding.entity_revision_id,
      manifest_membership: "REFERENCED_ONLY",
      relation_provenance: finding.supporting_paths,
    });
  }

  return index;
}

/** Looks up one or more entity ids in the index, dropping any not found (e.g. unresolved). */
export function sourceRefsFor(index: Map<string, SourceRef>, entityIds: readonly string[]): SourceRef[] {
  const refs: SourceRef[] = [];
  for (const id of entityIds) {
    const ref = index.get(id);
    if (ref) refs.push(ref);
  }
  return refs;
}
