// P3-FR-013 — Review of Stakeholder responses. Reads/updates
// form_responses.review_status; AC-01 "a response pending review
// does not automatically become Confirmed Evidence" is honored by
// this service never touching the Evidence module at all - turning
// a reviewed response into Evidence is a separate, explicit BA
// action in the Evidence module (P2-B), not implied by marking a
// response REVIEWED here.

import { HttpError } from "../../http/errors.js";
import { withTransaction } from "../../db/pool.js";
import * as repo from "./repository.js";

const REVIEW_STATUSES = ["PENDING_BA_REVIEW", "REVIEWED", "NEEDS_CLARIFICATION", "CONFLICT"] as const;

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

export interface ListResponsesQuery {
  status?: string;
}

export async function listResponsesService(caseId: string, query: ListResponsesQuery) {
  if (!isUuid(caseId)) {
    throw new HttpError("VALIDATION_ERROR", "case_id must be a valid UUID");
  }
  if (
    query.status !== undefined &&
    !REVIEW_STATUSES.includes(query.status as (typeof REVIEW_STATUSES)[number])
  ) {
    throw new HttpError(
      "VALIDATION_ERROR",
      `status must be one of: ${REVIEW_STATUSES.join(", ")}`,
    );
  }
  const rows = await repo.findResponsesByCaseId(caseId, query.status ?? null);
  return { data: rows };
}

export async function getResponseService(responseId: string) {
  if (!isUuid(responseId)) {
    throw new HttpError("VALIDATION_ERROR", "response_id must be a valid UUID");
  }
  const response = await repo.findResponseById(responseId);
  if (!response) {
    throw new HttpError("NOT_FOUND", `Form response ${responseId} was not found`);
  }
  const answers = await repo.findAnswersByResponseId(responseId);
  return { data: { ...response, answers } };
}

export interface UpdateResponseInput {
  review_status?: unknown;
}

// A pending response can move to any of the 3 outcomes; once
// reviewed/needs-clarification/conflict, re-review (e.g. after
// follow-up) is allowed back to any other state - this is review
// bookkeeping, not a strict one-way gate like Information Gap's
// state machine, since the SRS does not describe this transition as
// restricted the way it does for gaps/issues.
const REVIEWABLE_FROM = ["PENDING_BA_REVIEW", "REVIEWED", "NEEDS_CLARIFICATION", "CONFLICT"];

export async function updateResponseService(responseId: string, body: UpdateResponseInput) {
  if (!isUuid(responseId)) {
    throw new HttpError("VALIDATION_ERROR", "response_id must be a valid UUID");
  }
  if (
    typeof body.review_status !== "string" ||
    !REVIEW_STATUSES.includes(body.review_status as (typeof REVIEW_STATUSES)[number])
  ) {
    throw new HttpError(
      "VALIDATION_ERROR",
      `review_status must be one of: ${REVIEW_STATUSES.join(", ")}`,
    );
  }

  const existing = await repo.findResponseById(responseId);
  if (!existing) {
    throw new HttpError("NOT_FOUND", `Form response ${responseId} was not found`);
  }
  if (!REVIEWABLE_FROM.includes(existing.review_status)) {
    throw new HttpError(
      "VALIDATION_ERROR",
      `Cannot update review_status from ${existing.review_status}`,
    );
  }

  const result = await withTransaction((client) =>
    repo.updateResponseReviewStatus(client, {
      responseId,
      reviewStatus: body.review_status as string,
    }),
  );

  if (!result) {
    throw new HttpError("NOT_FOUND", `Form response ${responseId} was not found`);
  }

  return { data: result };
}
