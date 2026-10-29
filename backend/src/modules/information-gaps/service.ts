// P3-FR-009 / FR-010 / FR-015 — Information Gap tracking. This is
// BA-recorded gap tracking only: automatic gap detection via
// rule/heuristic/AI (FR-009 AC-04 "do AI hoặc heuristic phát hiện")
// is explicitly out of scope for this MVP slice per the Application
// Functional Guide ("chưa cần triển khai... rule engine... AI thực
// tế"). A BA creates a gap manually when they notice one; no
// automatic analysis runs here.
//
// information_gaps.gap_id DOES carry a FK to entity_identities
// (added by a later repair migration, confirmed the hard way via a
// live 23503 foreign-key violation during integration testing). Every
// create registers a new entity and writes its first revision; every
// status update writes the next revision. Unlike discovery_answers,
// this table has no current_revision_no column of its own, so the
// next revision number is read from entity_revisions directly via
// getLatestRevisionNo() rather than from a column on the row.

import { HttpError } from "../../http/errors.js";
import { withTransaction } from "../../db/pool.js";
import * as repo from "./repository.js";
import { registerEntity, createRevision, getLatestRevisionNo } from "../entities/repository.js";

const CONDITION_TYPES = ["MISSING", "UNKNOWN", "AMBIGUITY", "CONFLICT", "DEPENDENCY"] as const;
const GAP_STATUSES = ["OPEN", "CLARIFYING", "RESOLVED"] as const;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

export interface ListGapsQuery {
  status?: string;
}

export async function listGapsService(caseId: string, query: ListGapsQuery) {
  if (!isUuid(caseId)) {
    throw new HttpError("VALIDATION_ERROR", "case_id must be a valid UUID");
  }
  if (
    query.status !== undefined &&
    !GAP_STATUSES.includes(query.status as (typeof GAP_STATUSES)[number])
  ) {
    throw new HttpError("VALIDATION_ERROR", `status must be one of: ${GAP_STATUSES.join(", ")}`);
  }
  const rows = await repo.findGapsByCaseId(caseId, query.status ?? null);
  return { data: rows };
}

export interface CreateGapInput {
  condition_type?: unknown;
  required_information_key?: unknown;
  affected_entity_id?: unknown;
  gap_summary?: unknown;
}

export async function createGapService(
  caseId: string,
  body: CreateGapInput,
  callerUserId: string,
) {
  if (!isUuid(caseId)) {
    throw new HttpError("VALIDATION_ERROR", "case_id must be a valid UUID");
  }
  if (
    typeof body.condition_type !== "string" ||
    !CONDITION_TYPES.includes(body.condition_type as (typeof CONDITION_TYPES)[number])
  ) {
    throw new HttpError(
      "VALIDATION_ERROR",
      `condition_type must be one of: ${CONDITION_TYPES.join(", ")}`,
    );
  }
  if (!isNonEmptyString(body.gap_summary)) {
    throw new HttpError("VALIDATION_ERROR", "gap_summary is required");
  }
  const requiredInformationKey =
    typeof body.required_information_key === "string" ? body.required_information_key : null;
  const affectedEntityId =
    typeof body.affected_entity_id === "string" && body.affected_entity_id.trim()
      ? body.affected_entity_id
      : null;
  if (affectedEntityId !== null && !isUuid(affectedEntityId)) {
    throw new HttpError("VALIDATION_ERROR", "affected_entity_id must be a valid UUID when provided");
  }

  const result = await withTransaction(async (client) => {
    const gapId = await registerEntity(client, "INFORMATION_GAP");

    const created = await repo.insertGap(client, {
      gapId,
      caseId,
      conditionType: body.condition_type as string,
      requiredInformationKey,
      affectedEntityId,
      gapSummary: body.gap_summary as string,
    });

    await createRevision(client, {
      entityId: gapId,
      revisionNo: 1,
      content: { condition_type: created.condition_type, gap_summary: created.gap_summary, gap_status: created.gap_status },
      createdBy: callerUserId,
      changeSummary: "Information gap created",
    });

    return created;
  });

  return { data: result };
}

export interface UpdateGapInput {
  gap_status?: unknown;
}

// Mirrors the state machine in SRS section 5.3: Open -> In
// Clarification -> Resolved, reopenable (Resolved -> Open) per the
// same table. The schema's own column names use CLARIFYING rather
// than "In Clarification" - this service uses the DB's exact
// vocabulary, not the SRS prose label.
const ALLOWED_TRANSITIONS: Record<string, string[]> = {
  OPEN: ["CLARIFYING", "RESOLVED"],
  CLARIFYING: ["OPEN", "RESOLVED"],
  RESOLVED: ["OPEN"],
};

export async function updateGapService(
  gapId: string,
  body: UpdateGapInput,
  callerUserId: string,
) {
  if (!isUuid(gapId)) {
    throw new HttpError("VALIDATION_ERROR", "gap_id must be a valid UUID");
  }
  if (
    typeof body.gap_status !== "string" ||
    !GAP_STATUSES.includes(body.gap_status as (typeof GAP_STATUSES)[number])
  ) {
    throw new HttpError("VALIDATION_ERROR", `gap_status must be one of: ${GAP_STATUSES.join(", ")}`);
  }

  const existing = await repo.findGapById(gapId);
  if (!existing) {
    throw new HttpError("NOT_FOUND", `Information gap ${gapId} was not found`);
  }

  const allowedNext = ALLOWED_TRANSITIONS[existing.gap_status] ?? [];
  if (!allowedNext.includes(body.gap_status)) {
    throw new HttpError(
      "VALIDATION_ERROR",
      `Cannot transition gap from ${existing.gap_status} to ${body.gap_status}`,
    );
  }

  const resolvedAt = body.gap_status === "RESOLVED" ? new Date().toISOString() : null;

  const result = await withTransaction(async (client) => {
    const updated = await repo.updateGapStatus(client, {
      gapId,
      gapStatus: body.gap_status as string,
      resolvedAt,
    });

    if (!updated) {
      throw new HttpError("NOT_FOUND", `Information gap ${gapId} was not found`);
    }

    const latestRevisionNo = await getLatestRevisionNo(client, gapId);
    await createRevision(client, {
      entityId: gapId,
      revisionNo: latestRevisionNo + 1,
      content: { gap_status: updated.gap_status, resolved_at: updated.resolved_at },
      createdBy: callerUserId,
      changeSummary: "Information gap status updated",
    });

    return updated;
  });

  return { data: result };
}
