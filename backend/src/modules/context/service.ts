// P3-FR-002 — Context Management. Each BusinessContext row is one
// independently-tracked fact (problem, need, current state, desired
// state, stakeholder, scope, constraint, dependency - context_type is
// free text per the schema, no DB-level whitelist), with its own
// Known/Unknown/Assumption status and revision history via the shared
// EntityIdentity/EntityRevision infra.

import { HttpError } from "../../http/errors.js";
import { withTransaction } from "../../db/pool.js";
import { registerEntity, createRevision } from "../entities/repository.js";
import * as repo from "./repository.js";

const KNOWLEDGE_STATUSES = ["KNOWN", "UNKNOWN", "ASSUMPTION"] as const;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

export async function listContextsService(caseId: string) {
  if (!isUuid(caseId)) {
    throw new HttpError("VALIDATION_ERROR", "case_id must be a valid UUID");
  }
  const rows = await repo.findContextsByCaseId(caseId);
  return { data: rows };
}

export interface CreateContextInput {
  context_type?: unknown;
  content?: unknown;
  knowledge_status?: unknown;
  source_entity_id?: unknown;
}

export async function createContextService(
  caseId: string,
  body: CreateContextInput,
  callerUserId: string,
) {
  if (!isUuid(caseId)) {
    throw new HttpError("VALIDATION_ERROR", "case_id must be a valid UUID");
  }
  if (!isNonEmptyString(body.context_type)) {
    throw new HttpError("VALIDATION_ERROR", "context_type is required");
  }
  if (!isNonEmptyString(body.content)) {
    throw new HttpError("VALIDATION_ERROR", "content is required");
  }
  if (
    typeof body.knowledge_status !== "string" ||
    !KNOWLEDGE_STATUSES.includes(body.knowledge_status as (typeof KNOWLEDGE_STATUSES)[number])
  ) {
    throw new HttpError(
      "VALIDATION_ERROR",
      `knowledge_status must be one of: ${KNOWLEDGE_STATUSES.join(", ")}`,
    );
  }
  const sourceEntityId =
    typeof body.source_entity_id === "string" && body.source_entity_id.trim()
      ? body.source_entity_id
      : null;
  if (sourceEntityId !== null && !isUuid(sourceEntityId)) {
    throw new HttpError("VALIDATION_ERROR", "source_entity_id must be a valid UUID when provided");
  }

  const result = await withTransaction(async (client) => {
    // context_id IS the entity_id (shared PK per Data Dictionary) -
    // register the identity first so business_contexts' FK to
    // entity_identities resolves.
    const contextId = await registerEntity(client, "BUSINESS_CONTEXT");

    const created = await repo.insertContext(client, {
      contextId,
      caseId,
      contextType: body.context_type as string,
      content: body.content as string,
      knowledgeStatus: body.knowledge_status as string,
      sourceEntityId,
    });

    await createRevision(client, {
      entityId: contextId,
      revisionNo: 1,
      content: { content: created.content, knowledge_status: created.knowledge_status },
      createdBy: callerUserId,
      changeSummary: "Context created",
    });

    return created;
  });

  return { data: result };
}

export interface UpdateContextInput {
  content?: unknown;
  knowledge_status?: unknown;
  source_entity_id?: unknown;
}

export async function updateContextService(
  contextId: string,
  body: UpdateContextInput,
  callerUserId: string,
) {
  if (!isUuid(contextId)) {
    throw new HttpError("VALIDATION_ERROR", "context_id must be a valid UUID");
  }
  if (!isNonEmptyString(body.content)) {
    throw new HttpError("VALIDATION_ERROR", "content is required");
  }
  if (
    typeof body.knowledge_status !== "string" ||
    !KNOWLEDGE_STATUSES.includes(body.knowledge_status as (typeof KNOWLEDGE_STATUSES)[number])
  ) {
    throw new HttpError(
      "VALIDATION_ERROR",
      `knowledge_status must be one of: ${KNOWLEDGE_STATUSES.join(", ")}`,
    );
  }
  const sourceEntityId =
    typeof body.source_entity_id === "string" && body.source_entity_id.trim()
      ? body.source_entity_id
      : null;
  if (sourceEntityId !== null && !isUuid(sourceEntityId)) {
    throw new HttpError("VALIDATION_ERROR", "source_entity_id must be a valid UUID when provided");
  }

  const existing = await repo.findContextById(contextId);
  if (!existing) {
    throw new HttpError("NOT_FOUND", `Context ${contextId} was not found`);
  }

  const result = await withTransaction(async (client) => {
    const newRevisionNo = existing.current_revision_no + 1;

    const updated = await repo.updateContext(client, {
      contextId,
      content: body.content as string,
      knowledgeStatus: body.knowledge_status as string,
      sourceEntityId,
      newRevisionNo,
    });

    if (!updated) {
      // Row disappeared between the read above and this transaction -
      // treat as not found rather than silently succeeding with
      // nothing updated.
      throw new HttpError("NOT_FOUND", `Context ${contextId} was not found`);
    }

    await createRevision(client, {
      entityId: contextId,
      revisionNo: newRevisionNo,
      content: { content: updated.content, knowledge_status: updated.knowledge_status },
      createdBy: callerUserId,
      changeSummary: "Context updated",
    });

    return updated;
  });

  return { data: result };
}
