// P3-FR-012 — Public form access and submission. These functions are
// called from a route that has NO authenticate()/requireRole()
// middleware attached - the caller is an unauthenticated stakeholder
// holding only a token from a shared link. Every lookup here must
// therefore verify the token itself (never trust a form_version_id
// or grant_id passed directly), and the response shape must never
// include anything beyond the form's own question content (FR-012
// AC-04).

import { createHash } from "node:crypto";
import { HttpError } from "../../http/errors.js";
import { withTransaction } from "../../db/pool.js";
import { findVersionById } from "../forms/repository.js";
import * as repo from "./repository.js";
import { getPool } from "../../db/pool.js";

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

interface ResolvedGrant {
  grant_id: string;
  form_version_id: string;
  stakeholder_id: string | null;
}

/**
 * Resolves a raw token to its grant row, verifying grant_status and
 * expires_at. Returns null for ANY failure reason (not found,
 * revoked, expired) - callers must treat all of these identically as
 * "this link is not usable", never distinguishing which one in the
 * response, matching the same non-enumerable-failure principle
 * authenticate.ts already uses for sessions.
 */
async function resolveActiveGrant(token: string): Promise<ResolvedGrant | null> {
  const tokenHash = hashToken(token);
  const { rows } = await getPool().query<ResolvedGrant>(
    `SELECT grant_id, form_version_id, stakeholder_id
     FROM public_access_grants
     WHERE token_hash = $1
       AND grant_status = 'OPEN'
       AND (expires_at IS NULL OR expires_at > now())`,
    [tokenHash],
  );
  return rows[0] ?? null;
}

export async function getPublicFormService(token: string) {
  if (typeof token !== "string" || token.length === 0) {
    throw new HttpError("VALIDATION_ERROR", "A valid access token is required");
  }

  const grant = await resolveActiveGrant(token);
  if (!grant) {
    throw new HttpError("NOT_FOUND", "This link is invalid, expired, or no longer active");
  }

  const view = await repo.findPublicFormView(grant.form_version_id);
  if (!view || view.publication_status !== "OPEN") {
    // A grant could in principle outlive its form version being
    // closed by the BA - treat that the same as "link not usable",
    // never exposing the version's internal status.
    throw new HttpError("NOT_FOUND", "This link is invalid, expired, or no longer active");
  }

  return { data: { formVersionId: view.form_version_id, questions: view.questions } };
}

export interface SubmitResponseInput {
  submitted_identity?: unknown;
  answers?: unknown;
}

interface AnswerInput {
  form_item_id?: unknown;
  answer_value?: unknown;
}

export async function submitFormResponseService(token: string, body: SubmitResponseInput) {
  if (typeof token !== "string" || token.length === 0) {
    throw new HttpError("VALIDATION_ERROR", "A valid access token is required");
  }

  const grant = await resolveActiveGrant(token);
  if (!grant) {
    throw new HttpError("NOT_FOUND", "This link is invalid, expired, or no longer active");
  }

  const version = await findVersionById(grant.form_version_id);
  if (!version || version.publication_status !== "OPEN") {
    throw new HttpError("NOT_FOUND", "This link is invalid, expired, or no longer active");
  }

  if (!Array.isArray(body.answers) || body.answers.length === 0) {
    throw new HttpError("VALIDATION_ERROR", "answers must be a non-empty array");
  }

  const view = await repo.findPublicFormView(grant.form_version_id);
  const validItemIds = new Set((view?.questions ?? []).map((q) => q.form_item_id));

  const answers = body.answers as AnswerInput[];
  for (let i = 0; i < answers.length; i++) {
    const a = answers[i]!;
    if (typeof a.form_item_id !== "string" || !validItemIds.has(a.form_item_id)) {
      throw new HttpError(
        "VALIDATION_ERROR",
        `answers[${i}].form_item_id must refer to a question on this form version`,
      );
    }
    if (a.answer_value === undefined) {
      throw new HttpError("VALIDATION_ERROR", `answers[${i}].answer_value is required`);
    }
  }

  const submittedIdentity =
    typeof body.submitted_identity === "string" ? body.submitted_identity : null;

  // case_id is derived server-side from the form version's own
  // owning Case (via stakeholder_forms) - NEVER accepted from the
  // unauthenticated caller. This both satisfies the
  // rt_check_form_response_case trigger and matches the explicit
  // requirement that a public submitter must never be able to assert
  // which Case their response belongs to.
  const { rows: caseRows } = await getPool().query<{ case_id: string }>(
    `SELECT sf.case_id
     FROM form_versions fv
     JOIN stakeholder_forms sf ON sf.form_id = fv.form_id
     WHERE fv.form_version_id = $1`,
    [grant.form_version_id],
  );
  const caseId = caseRows[0]?.case_id;
  if (!caseId) {
    // Should be unreachable given the FK chain, but fail loud rather
    // than insert a response with no resolvable Case if it ever is.
    throw new HttpError("INTERNAL_ERROR", "Could not resolve the owning case for this form");
  }

  const result = await withTransaction(async (client) => {
    const response = await repo.insertFormResponse(client, {
      formVersionId: grant.form_version_id,
      caseId,
      stakeholderId: grant.stakeholder_id,
      submittedIdentity,
      sourceGrantId: grant.grant_id,
    });

    for (const a of answers) {
      await repo.insertFormAnswer(client, {
        responseId: response.response_id,
        formVersionId: grant.form_version_id,
        formItemId: a.form_item_id as string,
        answerValue: a.answer_value,
      });
    }

    await repo.incrementGrantSubmissions(client, grant.grant_id);

    return response;
  });

  return { data: { responseId: result.response_id } };
}
