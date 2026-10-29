// AssessmentRecord — Completeness, Quality (Gate), and Readiness
// Assessment (Phase 6 Quality & Completeness Core). Reuses P2-D's
// Validation Run/baseline_manifests infrastructure entirely - this
// module creates NO validation engine of its own. Every Assessment is
// a synthesis OVER an existing (or freshly created) Validation Run's
// effective results, pinned to a FROZEN manifest, matching
// assessment_records' own schema (manifest_id NOT NULL, FK to
// baseline_manifests; rt_protect_final_assessment requires that
// manifest to be FROZEN for the same case_id at the moment of
// finalizing - see migration 015's comment).
//
// IMPORTANT, per explicit instruction: this module NEVER rewrites a
// validation_results row's result_outcome. A check's own result (PASS/
// FAIL/N_A/WARNING/UNKNOWN) is always reported exactly as
// createValidationRunService computed and stored it. What this module
// adds on top is strictly an AGGREGATION decision (Complete/Incomplete/
// Pass/Fail/Ready/etc.) computed FROM those stored results - obligation_
// level (see below) affects only this aggregation, never the
// individual check's own outcome.
//
// obligation_level (definition_body.obligation_level, seeded/updated by
// migrations 013/014/016): MANDATORY / CONDITIONAL / ADVISORY /
// UNDETERMINED. No approved Framework/SRS source defines this
// classification per check today (searched FR-016 through FR-024 in
// full) - all 5 existing CHECK_RULEs are therefore UNDETERMINED as of
// this batch (migration 016). Per explicit instruction: Quality Gate
// must NEVER report PASS while any APPLICABLE check still has
// obligation_level = UNDETERMINED, regardless of that check's own
// result_outcome. This is reported honestly as UNKNOWN with a
// finding_summary explaining the missing governance decision - never
// silently treated as PASS or as MANDATORY.

import { HttpError } from "../../http/errors.js";
import { withTransaction } from "../../db/pool.js";
import { createValidationRunService, getValidationRunService } from "../validation/service.js";
import { findAllActiveCheckRuleMeta } from "../validation/repository.js";
import { findOpenBlockerIssues } from "../issues/repository.js";
import * as repo from "./repository.js";

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

interface EffectiveResultWithMeta {
  check_definition_version_id: string;
  definition_code: string;
  review_mode: string | null;
  obligation_level: string | null;
  result_outcome: string;
  execution_status: string;
  finding_summary: string | null;
}

async function runAndClassify(caseId: string, callerUserId: string) {
  const runResult = await createValidationRunService(caseId, callerUserId);
  const run = runResult.data.run!;
  const manifest = runResult.data.manifest;
  const checkRuleMeta = await findAllActiveCheckRuleMeta();
  const metaByVersionId = new Map(checkRuleMeta.map((m) => [m.definition_version_id, m]));

  const withMeta: EffectiveResultWithMeta[] = runResult.data.results.map((r) => {
    const meta = metaByVersionId.get(r.check_definition_version_id);
    return {
      check_definition_version_id: r.check_definition_version_id,
      definition_code: meta?.definition_code ?? "UNKNOWN_CHECK_RULE",
      review_mode: meta?.review_mode ?? null,
      obligation_level: meta?.obligation_level ?? null,
      result_outcome: r.result_outcome,
      execution_status: r.execution_status,
      finding_summary: r.finding_summary,
    };
  });

  return { run, manifest, results: withMeta };
}

const COMPLETENESS_RELEVANT_CHECKS = new Set([
  "REQ_HAS_AC",
  "DISCOVERY_ANSWER_NOT_UNKNOWN_ON_COMPLETE",
  "INFORMATION_GAP_STILL_OPEN",
]);

/**
 * Completeness Assessment. Per explicit instruction: based on Required
 * Information / Module Checklist / Discovery Answer / Evidence
 * Coverage / Information Gap - NOT limited to P2-D's original 3
 * structural checks. In practice today this means all 5 deterministic
 * CHECK_RULEs are considered (the Module Completeness Checklist's own
 * detailed per-module criteria - DISC-CHK-01..11, the "F" sections of
 * each Discovery Module - remain judgment-based prose with no seeded
 * CHECK_RULE, so they are NOT silently assumed Complete; they simply
 * contribute nothing to this automatic computation, same as any other
 * un-seeded criterion).
 *
 * outcome:
 *   INCOMPLETE — any completeness-relevant check has result_outcome
 *     FAIL (a real completeness gap: a Requirement with no AC, a
 *     COMPLETED module with an UNKNOWN answer, evidence coverage not
 *     confirmed where cited).
 *   UNKNOWN — no FAIL, but at least one completeness-relevant check
 *     could not be meaningfully concluded (execution_status not
 *     EXECUTED, or obligation_level UNDETERMINED while still relevant
 *     - WARNING outcomes like an open Information Gap do NOT by
 *     themselves force UNKNOWN, since INFORMATION_GAP_STILL_OPEN is
 *     designed to warn, not block, per its own seed comment).
 *   COMPLETE — every completeness-relevant check PASS, N_A, or WARNING
 *     (WARNING is informational for this check, not a completeness
 *     blocker) and none UNKNOWN/NOT_EXECUTED.
 */
export async function createCompletenessAssessmentService(caseId: string, callerUserId: string) {
  if (!isUuid(caseId)) {
    throw new HttpError("VALIDATION_ERROR", "case_id must be a valid UUID");
  }

  const { run, manifest, results } = await runAndClassify(caseId, callerUserId);
  const relevant = results.filter((r) => COMPLETENESS_RELEVANT_CHECKS.has(r.definition_code));

  const notExecuted = relevant.filter((r) => r.execution_status !== "EXECUTED");
  const failing = relevant.filter((r) => r.result_outcome === "FAIL");

  let outcome: "COMPLETE" | "INCOMPLETE" | "UNKNOWN";
  let summary: string;
  if (failing.length > 0) {
    outcome = "INCOMPLETE";
    summary = `Completeness check(s) failed: ${failing.map((r) => r.definition_code).join(", ")}`;
  } else if (notExecuted.length > 0) {
    outcome = "UNKNOWN";
    summary = `Completeness check(s) did not execute: ${notExecuted.map((r) => r.definition_code).join(", ")}`;
  } else {
    outcome = "COMPLETE";
    summary = "All completeness-relevant checks passed, are not applicable, or are informational warnings";
  }

  const assessment = await withTransaction(async (client) => {
    const draft = await repo.insertDraftAssessment(client, {
      caseId,
      assessmentType: "COMPLETENESS",
      manifestId: manifest.manifest_id,
      policyVersionId: run.policy_version_id,
      validationRunId: run.validation_run_id,
      outcome,
      summary,
      resultDetails: { checks_considered: relevant.map((r) => r.definition_code) },
      assessedBy: callerUserId,
    });
    const finalized = await repo.finalizeAssessment(client, { assessmentId: draft.assessment_id });
    if (!finalized) {
      throw new HttpError("INTERNAL_ERROR", "Failed to finalize the completeness assessment");
    }
    return finalized;
  });

  return { data: assessment };
}

/**
 * Quality Gate (assessment_type = QUALITY). Per explicit instruction:
 * PASS only when every MANDATORY obligation that applies is met.
 * UNKNOWN, ERROR (FAILED_TO_RUN), or not-yet-executed never count as
 * PASS. N/A is only valid when the check itself determined N/A (never
 * assumed). Since no CHECK_RULE currently has an approved
 * obligation_level other than UNDETERMINED (see migration 016), this
 * Quality Gate can never report PASS today - it reports UNKNOWN with
 * an explicit list of which checks are blocking the gate on an
 * ungoverned obligation_level, which is the honest state of the
 * system, not a bug to work around.
 */
export async function createQualityAssessmentService(caseId: string, callerUserId: string) {
  if (!isUuid(caseId)) {
    throw new HttpError("VALIDATION_ERROR", "case_id must be a valid UUID");
  }

  const { run, manifest, results } = await runAndClassify(caseId, callerUserId);

  // "Applicable" excludes N_A results (the check itself determined it
  // doesn't apply) but includes everything else, since a FAIL/UNKNOWN/
  // WARNING/NOT_EXECUTED result is by definition something the check
  // DID apply to and evaluate (or attempted to).
  const applicable = results.filter((r) => r.result_outcome !== "N_A");

  const undeterminedObligation = applicable.filter((r) => r.obligation_level === "UNDETERMINED");
  const notMandatoryEvaluated = applicable.filter((r) => r.obligation_level === "MANDATORY");
  const failingMandatory = notMandatoryEvaluated.filter((r) => r.result_outcome === "FAIL");
  const notExecuted = applicable.filter((r) => r.execution_status !== "EXECUTED");
  const unknownOutcome = applicable.filter((r) => r.result_outcome === "UNKNOWN");

  let outcome: "PASS" | "FAIL" | "UNKNOWN";
  let summary: string;
  if (failingMandatory.length > 0) {
    outcome = "FAIL";
    summary = `Mandatory check(s) failed: ${failingMandatory.map((r) => r.definition_code).join(", ")}`;
  } else if (
    undeterminedObligation.length > 0 ||
    notExecuted.length > 0 ||
    unknownOutcome.length > 0
  ) {
    outcome = "UNKNOWN";
    const reasons: string[] = [];
    if (undeterminedObligation.length > 0) {
      reasons.push(
        `obligation_level not yet approved for: ${undeterminedObligation.map((r) => r.definition_code).join(", ")}`,
      );
    }
    if (notExecuted.length > 0) {
      reasons.push(`did not execute: ${notExecuted.map((r) => r.definition_code).join(", ")}`);
    }
    if (unknownOutcome.length > 0) {
      reasons.push(`returned UNKNOWN: ${unknownOutcome.map((r) => r.definition_code).join(", ")}`);
    }
    summary = `Quality Gate cannot conclude PASS - ${reasons.join("; ")}`;
  } else {
    outcome = "PASS";
    summary = "All mandatory checks that apply have passed";
  }

  const assessment = await withTransaction(async (client) => {
    const draft = await repo.insertDraftAssessment(client, {
      caseId,
      assessmentType: "QUALITY",
      manifestId: manifest.manifest_id,
      policyVersionId: run.policy_version_id,
      validationRunId: run.validation_run_id,
      outcome,
      summary,
      resultDetails: {
        undetermined_obligation: undeterminedObligation.map((r) => r.definition_code),
      },
      assessedBy: callerUserId,
    });
    const finalized = await repo.finalizeAssessment(client, { assessmentId: draft.assessment_id });
    if (!finalized) {
      throw new HttpError("INTERNAL_ERROR", "Failed to finalize the quality assessment");
    }
    return finalized;
  });

  return { data: assessment };
}

/**
 * Readiness Assessment (4.3 Readiness Classification). Per the
 * Framework: Ready requires Quality + Confirmation already achieved
 * AND no blocking dependency/blocker. This MVP slice has no
 * Stakeholder Confirmation checkpoint implemented as structured data
 * (Stakeholder Confirmation Checklist, CONF-CHK-*, is judgment-based
 * prose like most of Layer 2/3 - see validation/service.ts's docblock)
 * - Confirmation is therefore NOT evaluated automatically here; its
 * absence from automatic computation is reported explicitly, never
 * silently assumed satisfied.
 *
 * outcome:
 *   NOT_READY — the latest finalized QUALITY assessment for this Case
 *     is missing, or is not PASS.
 *   READY_BUT_BLOCKED — Quality is PASS, but >=1 open (unclosed)
 *     BLOCKER-type Issue exists for the Case (DEP-CHK-03's "blocker
 *     ảnh hưởng implementation" - findOpenBlockerIssues, NOT the same
 *     question as DEP_BLOCKER_RECORDED's CHECK_RULE).
 *   READY — Quality is PASS and no open BLOCKER Issue exists. Since
 *     Quality Gate can never be PASS today (all obligation_level are
 *     UNDETERMINED per migration 016), READY is unreachable until a
 *     human approves obligation_level for the relevant CHECK_RULEs -
 *     this is the correct, honest behavior, not a bug.
 */
export async function createReadinessAssessmentService(caseId: string, callerUserId: string) {
  if (!isUuid(caseId)) {
    throw new HttpError("VALIDATION_ERROR", "case_id must be a valid UUID");
  }

  const latestQuality = await repo.findLatestFinalizedAssessment(caseId, "QUALITY");

  let outcome: "READY" | "READY_BUT_BLOCKED" | "NOT_READY";
  let summary: string;
  const resultDetails: Record<string, unknown> = {
    quality_assessment_id: latestQuality?.assessment_id ?? null,
    quality_outcome: latestQuality?.outcome ?? null,
    stakeholder_confirmation_evaluated: false,
  };

  if (!latestQuality || latestQuality.outcome !== "PASS") {
    outcome = "NOT_READY";
    summary = latestQuality
      ? `Latest finalized Quality assessment is ${latestQuality.outcome}, not PASS`
      : "No finalized Quality assessment exists yet for this case";
  } else {
    const openBlockers = await findOpenBlockerIssues(caseId);
    resultDetails.open_blocker_issue_codes = openBlockers.map((b) => b.issue_code);
    if (openBlockers.length > 0) {
      outcome = "READY_BUT_BLOCKED";
      summary = `Quality is PASS, but ${openBlockers.length} open blocker issue(s) prevent implementation: ${openBlockers
        .map((b) => b.issue_code)
        .join(", ")}`;
    } else {
      outcome = "READY";
      summary = "Quality is PASS and no open blocker issues exist for this case";
    }
  }

  // Readiness still needs a FROZEN manifest + policy_version_id per
  // the schema's own FK/trigger requirements (migration 015's
  // comment) - reuses the Quality assessment's own manifest/policy
  // when one exists (the most recent authoritative input pinning),
  // otherwise runs a fresh Validation Run purely to obtain a frozen
  // manifest/policy marker for a NOT_READY record (no Quality
  // assessment exists yet to borrow from).
  let manifestId: string;
  let policyVersionId: string;
  let validationRunId: string | null;
  if (latestQuality) {
    manifestId = latestQuality.manifest_id;
    policyVersionId = latestQuality.policy_version_id;
    validationRunId = latestQuality.validation_run_id;
  } else {
    const { run, manifest } = await runAndClassify(caseId, callerUserId);
    manifestId = manifest.manifest_id;
    policyVersionId = run.policy_version_id;
    validationRunId = run.validation_run_id;
  }

  const assessment = await withTransaction(async (client) => {
    const draft = await repo.insertDraftAssessment(client, {
      caseId,
      assessmentType: "READINESS",
      manifestId,
      policyVersionId,
      validationRunId,
      outcome,
      summary,
      resultDetails,
      assessedBy: callerUserId,
    });
    const finalized = await repo.finalizeAssessment(client, { assessmentId: draft.assessment_id });
    if (!finalized) {
      throw new HttpError("INTERNAL_ERROR", "Failed to finalize the readiness assessment");
    }
    return finalized;
  });

  return { data: assessment };
}

export async function listAssessmentsService(caseId: string, assessmentType?: string) {
  if (!isUuid(caseId)) {
    throw new HttpError("VALIDATION_ERROR", "case_id must be a valid UUID");
  }
  const ASSESSMENT_TYPES = ["COMPLETENESS", "QUALITY", "READINESS", "IMPACT_REVIEW"];
  if (assessmentType !== undefined && !ASSESSMENT_TYPES.includes(assessmentType)) {
    throw new HttpError("VALIDATION_ERROR", `assessment_type must be one of: ${ASSESSMENT_TYPES.join(", ")}`);
  }
  const rows = await repo.findAssessmentsByCaseId(caseId, assessmentType ?? null);
  return { data: rows };
}

export async function getAssessmentService(assessmentId: string) {
  if (!isUuid(assessmentId)) {
    throw new HttpError("VALIDATION_ERROR", "assessment_id must be a valid UUID");
  }
  const row = await repo.findAssessmentById(assessmentId);
  if (!row) {
    throw new HttpError("NOT_FOUND", `Assessment ${assessmentId} was not found`);
  }
  return { data: row };
}

// Re-exported so routes.ts has a single import surface; getValidationRunService
// is not otherwise used here but keeps this module self-contained for
// any future "show me the underlying run" endpoint without reaching
// into another module's internals from routes.ts directly.
export { getValidationRunService as getUnderlyingValidationRunService };
