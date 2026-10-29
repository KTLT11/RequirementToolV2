// P2-D (Structural Validation) + Phase 6 Quality & Completeness Core.
// A ValidationResult row is always a *finding produced by a specific
// CHECK_RULE run*, never the same thing as the Issue or Information
// Gap row it may reference:
//   - Information Gap (information_gaps) — a BA-raised "missing
//     information" condition (FR-011), fully implemented in its own
//     module. INFORMATION_GAP_STILL_OPEN only READS information_gaps
//     to surface still-open gaps as a finding; it never creates,
//     updates, or resolves a gap itself.
//   - Issue (issues/issue_resolutions) — Blocker Management, its own
//     module (src/modules/issues). DEP_BLOCKER_RECORDED only READS
//     issues to check a BLOCKER has a recognized status; it never
//     creates, updates, or resolves an issue. Readiness Assessment
//     (see createReadinessAssessmentService) separately reads issues
//     directly (via findOpenBlockerIssues) to decide Ready vs Ready
//     but Blocked — a different question from DEP_BLOCKER_RECORDED's
//     "is the blocker recorded with a clear status at all".
// This module keeps that distinction by construction: it only ever
// writes validation_results/assessment_records (and the
// baseline_manifests/manifest_items/validation_runs rows that
// scaffold a run), nothing else.
//
// Two kinds of CHECK_RULE exist (definition_body.review_mode, seeded
// by migrations 013/014):
//   - DETERMINISTIC — evaluated automatically here, from data this
//     schema already records. Only 5 exist: REQ_HAS_AC, DISCOVERY_
//     ANSWER_NOT_UNKNOWN_ON_COMPLETE, INFORMATION_GAP_STILL_OPEN
//     (P2-D), EVIDENCE_COVERAGE_CONFIRMED, DEP_BLOCKER_RECORDED (this
//     batch). No CHECK_RULE beyond these 5 is invented.
//   - HUMAN_REVIEWED — every other Framework checklist item examined
//     for this batch (REQ-QC-*, AC-CHK-*, CONF-CHK-*, most of DISC-
//     CHK-*, READY-CHK-*, HANDOFF-CHK-*) describes BA judgment in
//     natural language with no SQL-evaluable criterion ("Pass khi
//     requirement rõ ràng, không ambiguous..."). None of these are
//     turned into CHECK_RULE rows by this batch - they remain outside
//     automatic Structural Validation entirely (no validation_results
//     row is ever auto-generated for a judgment-based criterion that
//     has no seeded CHECK_RULE). recordHumanReviewedResultService
//     exists so a BA CAN record an outcome for a HUMAN_REVIEWED
//     CHECK_RULE if/when one is specifically seeded and approved - but
//     this batch seeds none, since no specific judgment criterion was
//     approved with enough precision to seed as a named CHECK_RULE.
//
// This module makes no claim about overall Case readiness beyond
// Readiness Assessment's own narrow Ready/Ready but Blocked/Not Ready
// classification (4.3) - it never auto-decides anything judgment-based
// on the BA's behalf.

import { HttpError } from "../../http/errors.js";
import { withTransaction } from "../../db/pool.js";
import { createHash } from "node:crypto";
import { findActiveDefinitionVersionIdByCode } from "../definitions/repository.js";
import { findOpenBlockerIssues } from "../issues/repository.js";
import * as repo from "./repository.js";

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

const REQ_HAS_AC = "REQ_HAS_AC";
const DISCOVERY_ANSWER_NOT_UNKNOWN_ON_COMPLETE = "DISCOVERY_ANSWER_NOT_UNKNOWN_ON_COMPLETE";
const INFORMATION_GAP_STILL_OPEN = "INFORMATION_GAP_STILL_OPEN";
const EVIDENCE_COVERAGE_CONFIRMED = "EVIDENCE_COVERAGE_CONFIRMED";
const DEP_BLOCKER_RECORDED = "DEP_BLOCKER_RECORDED";

const RECOGNIZED_ISSUE_STATUSES = new Set(["OPEN", "IN_CLARIFICATION", "RESOLVED", "REOPENED"]);

async function requireActiveCheckRule(code: string): Promise<string> {
  const id = await findActiveDefinitionVersionIdByCode("CHECK_RULE", code);
  if (!id) {
    throw new HttpError(
      "INTERNAL_ERROR",
      `${code} is not seeded as an active CHECK_RULE definition - apply migration 013 first`,
    );
  }
  return id;
}

export async function createValidationRunService(caseId: string, callerUserId: string) {
  if (!isUuid(caseId)) {
    throw new HttpError("VALIDATION_ERROR", "case_id must be a valid UUID");
  }

  // Resolve all 3 CHECK_RULE definitions (and the policy marker - see
  // findActiveDefinitionVersionIdByCode's docblock) up front, before
  // any write, so a missing seed fails loud with a clear message
  // instead of partway through a manifest freeze.
  // This MVP slice has no separate POLICY definition_type - REQ_HAS_AC's
  // own definition_version_id doubles as validation_runs.policy_version_id
  // (see findActiveDefinitionVersionIdByCode's docblock).
  const reqHasAcDefId = await requireActiveCheckRule(REQ_HAS_AC);
  const policyVersionId = reqHasAcDefId;
  const answerNotUnknownDefId = await requireActiveCheckRule(DISCOVERY_ANSWER_NOT_UNKNOWN_ON_COMPLETE);
  const gapStillOpenDefId = await requireActiveCheckRule(INFORMATION_GAP_STILL_OPEN);
  const evidenceCoverageDefId = await requireActiveCheckRule(EVIDENCE_COVERAGE_CONFIRMED);
  const blockerRecordedDefId = await requireActiveCheckRule(DEP_BLOCKER_RECORDED);

  const requirements = await repo.findRequirementsWithAcCount(caseId);

  const manifest = await withTransaction(async (client) => {
    const draft = await repo.insertDraftManifest(client, {
      caseId,
      manifestPurpose: "VALIDATION",
      createdBy: callerUserId,
    });

    // Pin every current Requirement's latest entity_revisions row as
    // an ENTITY_REVISION manifest item - this IS the frozen input set
    // the validation run below evaluates against. Must happen before
    // freezing: rt_guard_manifest_item rejects manifest_items writes
    // once manifest_status = 'FROZEN'.
    const entityRevisionIds: string[] = [];
    let sortOrder = 1;
    for (const r of requirements) {
      const entityRevisionId = await repo.findCurrentEntityRevisionId(r.requirement_id);
      if (!entityRevisionId) {
        // Should be unreachable - every Requirement gets revision 1 at
        // creation - but fail loud rather than silently skip pinning
        // a Requirement into the manifest.
        throw new HttpError(
          "INTERNAL_ERROR",
          `No revision history found for requirement ${r.requirement_id}`,
        );
      }
      await repo.insertEntityRevisionManifestItem(client, {
        manifestId: draft.manifest_id,
        entityRevisionId,
        sortOrder: sortOrder++,
      });
      entityRevisionIds.push(entityRevisionId);
    }

    // manifest_sha256 per the schema is a digest of the frozen item
    // set - computed from the sorted entity_revision_id list so the
    // same Requirement set always hashes identically regardless of
    // insertion order.
    const sortedIds = [...entityRevisionIds].sort();
    const manifestSha256 = createHash("sha256").update(sortedIds.join(",")).digest("hex");

    const frozen = await repo.freezeManifest(client, {
      manifestId: draft.manifest_id,
      manifestSha256,
    });
    if (!frozen) {
      throw new HttpError("INTERNAL_ERROR", "Failed to freeze the baseline manifest");
    }

    return frozen;
  });

  const run = await withTransaction((client) =>
    repo.insertRunningValidationRun(client, {
      caseId,
      manifestId: manifest.manifest_id,
      policyVersionId,
      triggeredBy: callerUserId,
    }),
  );

  const findings: {
    checkDefinitionVersionId: string;
    targetEntityRevisionId: string | null;
    resultOutcome: "PASS" | "FAIL" | "UNKNOWN" | "N_A" | "WARNING";
    findingSummary: string | null;
    severity: string | null;
    resultDetails: unknown;
  }[] = [];

  // Check #1: Requirement has >= 1 Acceptance Criteria.
  if (requirements.length === 0) {
    findings.push({
      checkDefinitionVersionId: reqHasAcDefId,
      targetEntityRevisionId: null,
      resultOutcome: "N_A",
      findingSummary: "No requirements exist yet in this case",
      severity: null,
      resultDetails: { requirement_count: 0 },
    });
  } else {
    for (const r of requirements) {
      const entityRevisionId = await repo.findCurrentEntityRevisionId(r.requirement_id);
      if (r.ac_count > 0) {
        findings.push({
          checkDefinitionVersionId: reqHasAcDefId,
          targetEntityRevisionId: entityRevisionId,
          resultOutcome: "PASS",
          findingSummary: `Requirement ${r.requirement_code} has ${r.ac_count} acceptance criteria`,
          severity: null,
          resultDetails: { requirement_id: r.requirement_id, ac_count: r.ac_count },
        });
      } else {
        findings.push({
          checkDefinitionVersionId: reqHasAcDefId,
          targetEntityRevisionId: entityRevisionId,
          resultOutcome: "FAIL",
          findingSummary: `Requirement ${r.requirement_code} has no acceptance criteria`,
          severity: "HIGH",
          resultDetails: { requirement_id: r.requirement_id, ac_count: 0 },
        });
      }
    }
  }

  // Check #2: Discovery Answer must not be UNKNOWN when its Module
  // Application is COMPLETED.
  const unknownAnswers = await repo.findUnknownAnswersOnCompletedModules(caseId);
  if (unknownAnswers.length === 0) {
    findings.push({
      checkDefinitionVersionId: answerNotUnknownDefId,
      targetEntityRevisionId: null,
      resultOutcome: "PASS",
      findingSummary: "No UNKNOWN discovery answers on completed module applications",
      severity: null,
      resultDetails: { violation_count: 0 },
    });
  } else {
    for (const a of unknownAnswers) {
      const entityRevisionId = await repo.findCurrentEntityRevisionId(a.answer_id);
      findings.push({
        checkDefinitionVersionId: answerNotUnknownDefId,
        targetEntityRevisionId: entityRevisionId,
        resultOutcome: "FAIL",
        findingSummary: `Discovery answer ${a.answer_id} is UNKNOWN on a COMPLETED module application`,
        severity: "HIGH",
        resultDetails: { answer_id: a.answer_id, module_application_id: a.module_application_id },
      });
    }
  }

  // Check #3: Information Gap still OPEN/CLARIFYING - reported as a
  // finding, never resolved or mutated here.
  const openGaps = await repo.findOpenOrClarifyingGaps(caseId);
  if (openGaps.length === 0) {
    findings.push({
      checkDefinitionVersionId: gapStillOpenDefId,
      targetEntityRevisionId: null,
      resultOutcome: "PASS",
      findingSummary: "No open or clarifying information gaps",
      severity: null,
      resultDetails: { open_gap_count: 0 },
    });
  } else {
    for (const g of openGaps) {
      const entityRevisionId = await repo.findCurrentEntityRevisionId(g.gap_id);
      findings.push({
        checkDefinitionVersionId: gapStillOpenDefId,
        targetEntityRevisionId: entityRevisionId,
        resultOutcome: "WARNING",
        findingSummary: `Information gap still ${g.gap_status}: ${g.gap_summary}`,
        severity: "MEDIUM",
        resultDetails: { gap_id: g.gap_id, gap_status: g.gap_status },
      });
    }
  }

  // Check #4: Evidence Coverage Confirmed (Framework 0.6). Only
  // Decisions that DO cite source_evidence_id are evaluated - a
  // Decision with none is simply not in this check's scope (no finding
  // row at all for it), not a FAIL.
  const decisionsWithCoverage = await repo.findDecisionsWithEvidenceCoverage(caseId);
  if (decisionsWithCoverage.length === 0) {
    findings.push({
      checkDefinitionVersionId: evidenceCoverageDefId,
      targetEntityRevisionId: null,
      resultOutcome: "N_A",
      findingSummary: "No business decision in this case cites a source_evidence_id",
      severity: null,
      resultDetails: { decisions_with_coverage: 0 },
    });
  } else {
    for (const d of decisionsWithCoverage) {
      const entityRevisionId = await repo.findCurrentEntityRevisionId(d.decision_id);
      if (d.evidence_status === "CONFIRMED") {
        findings.push({
          checkDefinitionVersionId: evidenceCoverageDefId,
          targetEntityRevisionId: entityRevisionId,
          resultOutcome: "PASS",
          findingSummary: `Decision ${d.decision_subject} cites CONFIRMED evidence`,
          severity: null,
          resultDetails: { decision_id: d.decision_id, source_evidence_id: d.source_evidence_id },
        });
      } else {
        findings.push({
          checkDefinitionVersionId: evidenceCoverageDefId,
          targetEntityRevisionId: entityRevisionId,
          resultOutcome: "FAIL",
          findingSummary: `Decision ${d.decision_subject} cites evidence with status ${d.evidence_status}, not CONFIRMED`,
          severity: "HIGH",
          resultDetails: {
            decision_id: d.decision_id,
            source_evidence_id: d.source_evidence_id,
            evidence_status: d.evidence_status,
          },
        });
      }
    }
  }

  // Check #5: Dependency Blocker Recorded (DEP-CHK-03). Checks only
  // that a BLOCKER issue, if any, carries a recognized issue_status -
  // NOT whether it has been resolved (see repository.ts's comment).
  const blockerIssues = await repo.findBlockerIssuesForCheck(caseId);
  if (blockerIssues.length === 0) {
    findings.push({
      checkDefinitionVersionId: blockerRecordedDefId,
      targetEntityRevisionId: null,
      resultOutcome: "PASS",
      findingSummary: "No blocker issues recorded for this case",
      severity: null,
      resultDetails: { blocker_count: 0 },
    });
  } else {
    for (const issue of blockerIssues) {
      const entityRevisionId = await repo.findCurrentEntityRevisionId(issue.issue_id);
      if (RECOGNIZED_ISSUE_STATUSES.has(issue.issue_status)) {
        findings.push({
          checkDefinitionVersionId: blockerRecordedDefId,
          targetEntityRevisionId: entityRevisionId,
          resultOutcome: "PASS",
          findingSummary: `Blocker ${issue.issue_code} is recorded with status ${issue.issue_status}`,
          severity: null,
          resultDetails: { issue_id: issue.issue_id, issue_status: issue.issue_status },
        });
      } else {
        findings.push({
          checkDefinitionVersionId: blockerRecordedDefId,
          targetEntityRevisionId: entityRevisionId,
          resultOutcome: "FAIL",
          findingSummary: `Blocker ${issue.issue_code} has an unrecognized issue_status`,
          severity: "MEDIUM",
          resultDetails: { issue_id: issue.issue_id, issue_status: issue.issue_status },
        });
      }
    }
  }

  const results = await withTransaction(async (client) => {
    const inserted = [];
    for (const f of findings) {
      inserted.push(
        await repo.insertValidationResult(client, {
          validationRunId: run.validation_run_id,
          checkDefinitionVersionId: f.checkDefinitionVersionId,
          targetEntityRevisionId: f.targetEntityRevisionId,
          resultOutcome: f.resultOutcome,
          findingSummary: f.findingSummary,
          severity: f.severity,
          resultDetails: f.resultDetails,
        }),
      );
    }
    const completed = await repo.completeValidationRun(client, {
      validationRunId: run.validation_run_id,
      runStatus: "COMPLETED",
    });
    return { run: completed, results: inserted };
  });

  return { data: { manifest, ...results } };
}

export async function listValidationRunsService(caseId: string) {
  if (!isUuid(caseId)) {
    throw new HttpError("VALIDATION_ERROR", "case_id must be a valid UUID");
  }
  const rows = await repo.findValidationRunsByCaseId(caseId);
  return { data: rows };
}

export async function getValidationRunService(validationRunId: string) {
  if (!isUuid(validationRunId)) {
    throw new HttpError("VALIDATION_ERROR", "validation_run_id must be a valid UUID");
  }
  const run = await repo.findValidationRunById(validationRunId);
  if (!run) {
    throw new HttpError("NOT_FOUND", `Validation run ${validationRunId} was not found`);
  }
  // Effective results: the latest row per (check, target), which may
  // be a human-reviewed row superseding the original automatic one.
  // The full history (including superseded rows) is still in the
  // table, just not returned here - see findEffectiveResultsByRunId's
  // docblock.
  const results = await repo.findEffectiveResultsByRunId(validationRunId);
  return { data: { ...run, results } };
}

export interface RecordHumanReviewedResultInput {
  check_rule_code?: unknown;
  result_outcome?: unknown;
  finding_summary?: unknown;
  target_entity_id?: unknown;
}

const RESULT_OUTCOMES = ["PASS", "FAIL", "UNKNOWN", "N_A", "WARNING"] as const;

/**
 * Records a BA's human-reviewed outcome for a HUMAN_REVIEWED CHECK_RULE
 * against an existing validation_run. Per the approved instruction:
 * never updates or deletes an existing validation_results row (that
 * table has no UPDATE/DELETE grant at all, and validation_results rows
 * for a run already reported are historical record) - this always
 * INSERTs a new row with evaluated_at = now(), so the effective result
 * (see findEffectiveResultsByRunId) becomes this new one while the
 * prior row (whatever it was - UNKNOWN, a stale automatic result, or
 * an earlier human review) remains intact in the table.
 *
 * Requires the named CHECK_RULE to exist, be ACTIVE, and be seeded
 * with definition_body.review_mode = 'HUMAN_REVIEWED' - this endpoint
 * refuses to let a human override a DETERMINISTIC check's automatic
 * result (that would silently defeat the point of it being automatic),
 * and refuses an unknown/unseeded code rather than accept an arbitrary
 * string. finding_summary is mandatory here (unlike the automatic
 * checks, which sometimes have a null summary for a plain PASS) since
 * a human review's basis/evidence is exactly what distinguishes it
 * from an unexplained guess.
 */
export async function recordHumanReviewedResultService(
  validationRunId: string,
  body: RecordHumanReviewedResultInput,
  reviewerUserId: string,
): Promise<{ data: repo.ValidationResultRow }> {
  if (!isUuid(validationRunId)) {
    throw new HttpError("VALIDATION_ERROR", "validation_run_id must be a valid UUID");
  }
  const run = await repo.findValidationRunById(validationRunId);
  if (!run) {
    throw new HttpError("NOT_FOUND", `Validation run ${validationRunId} was not found`);
  }

  if (typeof body.check_rule_code !== "string" || body.check_rule_code.trim().length === 0) {
    throw new HttpError("VALIDATION_ERROR", "check_rule_code is required");
  }
  if (
    typeof body.result_outcome !== "string" ||
    !RESULT_OUTCOMES.includes(body.result_outcome as (typeof RESULT_OUTCOMES)[number])
  ) {
    throw new HttpError("VALIDATION_ERROR", `result_outcome must be one of: ${RESULT_OUTCOMES.join(", ")}`);
  }
  if (typeof body.finding_summary !== "string" || body.finding_summary.trim().length === 0) {
    throw new HttpError(
      "VALIDATION_ERROR",
      "finding_summary is required - it must state the reviewer's basis/evidence for this outcome",
    );
  }
  const targetEntityId =
    typeof body.target_entity_id === "string" && body.target_entity_id.trim()
      ? body.target_entity_id
      : null;
  if (targetEntityId !== null && !isUuid(targetEntityId)) {
    throw new HttpError("VALIDATION_ERROR", "target_entity_id must be a valid UUID when provided");
  }

  const checkRule = await repo.findCheckRuleWithReviewMode(body.check_rule_code);
  if (!checkRule) {
    throw new HttpError(
      "VALIDATION_ERROR",
      "check_rule_code does not refer to an active CHECK_RULE definition",
    );
  }
  if (checkRule.review_mode !== "HUMAN_REVIEWED") {
    throw new HttpError(
      "VALIDATION_ERROR",
      `${body.check_rule_code} is a DETERMINISTIC check - its result is computed automatically and cannot be overridden by a human-reviewed entry`,
    );
  }

  const targetEntityRevisionId = targetEntityId
    ? await repo.findCurrentEntityRevisionId(targetEntityId)
    : null;
  if (targetEntityId && !targetEntityRevisionId) {
    throw new HttpError(
      "VALIDATION_ERROR",
      "target_entity_id does not refer to an entity with any recorded revision",
    );
  }

  const result = await withTransaction((client) =>
    repo.insertValidationResult(client, {
      validationRunId,
      checkDefinitionVersionId: checkRule.definition_version_id,
      targetEntityRevisionId,
      resultOutcome: body.result_outcome as (typeof RESULT_OUTCOMES)[number],
      findingSummary: body.finding_summary as string,
      severity: null,
      resultDetails: { review_mode: "HUMAN_REVIEWED", reviewed_by: reviewerUserId },
    }),
  );

  return { data: result };
}
