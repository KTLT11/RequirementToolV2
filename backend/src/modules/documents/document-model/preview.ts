// B3.2 — Working Preview. Builds a DocumentModel from a BA-selected
// scope WITHOUT freezing anything - no Snapshot, no Publication, no
// write to any canonical table. Per the approved contract (#7): built
// from one exact source package resolution (resolveSourcePackage,
// called exactly once here), never a second independent resolve that
// could silently drift from what this function returns.
//
// Read-only end to end - every function this module calls
// (resolveSourcePackage, findEntityType, every section builder) only
// SELECTs. Safe to call repeatedly without any side effect, and safe
// to call before a Document row even exists (documentId is optional -
// a BA previewing content before deciding to create the Document at
// all is a legitimate use, per #7's "không tạo Snapshot/Publication").

import { HttpError } from "../../../http/errors.js";
import { resolveSourcePackage } from "../source-resolver.js";
import { buildSourceRefIndex } from "./source-refs.js";
import { buildDocumentModel } from "./registry.js";
import type { DocumentType, WorkingPreviewResult, ResolvedSourcePackageRef } from "./types.js";

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

export interface WorkingPreviewInput {
  document_type?: unknown;
  case_id?: unknown;
  document_id?: unknown; // optional - a Document row need not exist yet
  scope_entity_ids?: unknown;
  confirmable_entity_ids?: unknown;
}

const DOCUMENT_TYPES = ["CRD", "DRD"] as const;

/**
 * Builds a Working Preview: resolves the source package exactly once
 * (scope + its dependency closure, each entity's current revision at
 * this moment), then builds a DocumentModel from that single
 * resolution - never re-resolving mid-build. Returns the DocumentModel
 * together with the exact (entity_id, entity_revision_id) pairs
 * resolved, so a B3.3 Snapshot Builder can later pass this same
 * package back to createSnapshotService for a consistency check
 * before freezing (see B3.1's Snapshot Builder contract) - this
 * function itself never calls createSnapshotService or writes
 * anything.
 */
export async function buildWorkingPreviewService(body: WorkingPreviewInput): Promise<{ data: WorkingPreviewResult }> {
  if (
    typeof body.document_type !== "string" ||
    !DOCUMENT_TYPES.includes(body.document_type as (typeof DOCUMENT_TYPES)[number])
  ) {
    throw new HttpError("VALIDATION_ERROR", `document_type must be one of: ${DOCUMENT_TYPES.join(", ")}`);
  }
  if (typeof body.case_id !== "string" || !isUuid(body.case_id)) {
    throw new HttpError("VALIDATION_ERROR", "case_id must be a valid UUID");
  }
  if (body.document_id !== undefined && body.document_id !== null) {
    if (typeof body.document_id !== "string" || !isUuid(body.document_id)) {
      throw new HttpError("VALIDATION_ERROR", "document_id must be a valid UUID when provided");
    }
  }
  if (!Array.isArray(body.scope_entity_ids) || body.scope_entity_ids.length === 0) {
    throw new HttpError(
      "VALIDATION_ERROR",
      "scope_entity_ids must be a non-empty array naming the entities this preview represents",
    );
  }
  const scopeEntityIds = body.scope_entity_ids as unknown[];
  for (let i = 0; i < scopeEntityIds.length; i++) {
    const id = scopeEntityIds[i];
    if (typeof id !== "string" || !isUuid(id)) {
      throw new HttpError("VALIDATION_ERROR", `scope_entity_ids[${i}] must be a valid UUID`);
    }
  }

  const confirmableEntityIds = new Set<string>(
    Array.isArray(body.confirmable_entity_ids) ? (body.confirmable_entity_ids as unknown[] as string[]) : [],
  );
  let i = 0;
  for (const id of confirmableEntityIds) {
    if (typeof id !== "string" || !isUuid(id)) {
      throw new HttpError("VALIDATION_ERROR", `confirmable_entity_ids[${i}] must be a valid UUID`);
    }
    if (!(scopeEntityIds as string[]).includes(id)) {
      throw new HttpError(
        "VALIDATION_ERROR",
        `confirmable_entity_ids[${i}] (${id}) must also be present in scope_entity_ids`,
      );
    }
    i++;
  }

  // Resolved exactly once - this call is the single source of truth
  // for every entity_revision_id this preview (and its DocumentModel)
  // will reference. No section builder, and no other part of this
  // function, calls resolveDependencyClosure or findCurrentEntityRevisionId
  // again after this line.
  const pkg = await resolveSourcePackage(scopeEntityIds as string[]);
  const sourceRefIndex = buildSourceRefIndex(pkg, confirmableEntityIds);

  const documentModel = await buildDocumentModel({
    documentType: body.document_type as DocumentType,
    caseId: body.case_id,
    documentId: typeof body.document_id === "string" ? body.document_id : null,
    scopeEntityIds: scopeEntityIds as string[],
    sourceRefIndex,
  });

  const sourcePackageRef: ResolvedSourcePackageRef = {
    scope: pkg.scope
      .filter((f) => f.entity_revision_id !== null)
      .map((f) => ({
        entity_id: f.entity_id,
        entity_revision_id: f.entity_revision_id!,
        membership: confirmableEntityIds.has(f.entity_id) ? ("CONFIRMABLE" as const) : ("INCLUDED" as const),
      })),
    referenced_only: pkg.referenced_only
      .filter((f) => f.entity_revision_id !== null)
      .map((f) => ({
        entity_id: f.entity_id,
        entity_revision_id: f.entity_revision_id!,
        supporting_paths: f.supporting_paths,
      })),
  };

  return {
    data: {
      document_model: documentModel,
      source_package_ref: sourcePackageRef,
      eligibility_findings: [...pkg.scope, ...pkg.referenced_only],
    },
  };
}
