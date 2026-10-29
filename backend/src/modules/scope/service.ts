// P3-FR-002 / FR-026 — Case Scope. One versioned scope object per
// Case (in-scope / out-of-scope / boundary / constraints), with
// revision history via the shared EntityIdentity/EntityRevision
// infra. scope_status defaults to DRAFT in the DB (no CHECK
// whitelist exists there), so this service does not invent one
// either - any non-empty string is accepted and passed through
// as-is, matching the schema's actual constraints rather than a
// stricter rule nobody approved.

import { HttpError } from "../../http/errors.js";
import { withTransaction } from "../../db/pool.js";
import { registerEntity, createRevision } from "../entities/repository.js";
import * as repo from "./repository.js";

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

export async function getScopeService(caseId: string) {
  if (!isUuid(caseId)) {
    throw new HttpError("VALIDATION_ERROR", "case_id must be a valid UUID");
  }
  const scope = await repo.findScopeByCaseId(caseId);
  // Returning null data (not a 404) when no scope exists yet - unlike
  // a Case, which must exist to be addressed by id, "no scope defined
  // yet" is an expected, valid state for a Case early in Layer 0, not
  // an error.
  return { data: scope };
}

export interface PutScopeInput {
  scope_name?: unknown;
  in_scope?: unknown;
  out_of_scope?: unknown;
  boundary_notes?: unknown;
  constraints_json?: unknown;
  scope_status?: unknown;
}

function validateCommonFields(body: PutScopeInput): {
  scopeName: string;
  inScope: string;
  outOfScope: string | null;
  boundaryNotes: string | null;
  constraintsJson: unknown;
} {
  if (!isNonEmptyString(body.scope_name)) {
    throw new HttpError("VALIDATION_ERROR", "scope_name is required");
  }
  if (!isNonEmptyString(body.in_scope)) {
    throw new HttpError("VALIDATION_ERROR", "in_scope is required");
  }
  if (body.constraints_json !== undefined && !Array.isArray(body.constraints_json)) {
    throw new HttpError("VALIDATION_ERROR", "constraints_json must be an array when provided");
  }
  return {
    scopeName: body.scope_name as string,
    inScope: body.in_scope as string,
    outOfScope: typeof body.out_of_scope === "string" ? body.out_of_scope : null,
    boundaryNotes: typeof body.boundary_notes === "string" ? body.boundary_notes : null,
    constraintsJson: body.constraints_json ?? [],
  };
}

/**
 * PUT semantics: creates the Case's scope if none exists yet, or
 * creates a new revision of the existing one otherwise. A single
 * endpoint matches FR-002's framing of scope as "the current scope",
 * not a list the caller manages separately - the caller never needs
 * to know whether this is the first version or the tenth.
 */
export async function putScopeService(
  caseId: string,
  body: PutScopeInput,
  callerUserId: string,
) {
  if (!isUuid(caseId)) {
    throw new HttpError("VALIDATION_ERROR", "case_id must be a valid UUID");
  }
  const fields = validateCommonFields(body);
  const scopeStatus = isNonEmptyString(body.scope_status) ? body.scope_status : "DRAFT";

  const existing = await repo.findScopeByCaseId(caseId);

  const result = await withTransaction(async (client) => {
    if (!existing) {
      const scopeId = await registerEntity(client, "CASE_SCOPE");
      const created = await repo.insertScope(client, {
        scopeId,
        caseId,
        scopeName: fields.scopeName,
        inScope: fields.inScope,
        outOfScope: fields.outOfScope,
        boundaryNotes: fields.boundaryNotes,
        constraintsJson: fields.constraintsJson,
      });
      await createRevision(client, {
        entityId: scopeId,
        revisionNo: 1,
        content: created,
        createdBy: callerUserId,
        changeSummary: "Scope created",
      });
      return created;
    }

    const newRevisionNo = existing.current_revision_no + 1;
    const updated = await repo.updateScope(client, {
      scopeId: existing.scope_id,
      scopeName: fields.scopeName,
      inScope: fields.inScope,
      outOfScope: fields.outOfScope,
      boundaryNotes: fields.boundaryNotes,
      constraintsJson: fields.constraintsJson,
      scopeStatus: scopeStatus as string,
      newRevisionNo,
    });
    if (!updated) {
      throw new HttpError("NOT_FOUND", `Scope for case ${caseId} was not found`);
    }
    await createRevision(client, {
      entityId: existing.scope_id,
      revisionNo: newRevisionNo,
      content: updated,
      createdBy: callerUserId,
      changeSummary: "Scope updated",
    });
    return updated;
  });

  return { data: result };
}
