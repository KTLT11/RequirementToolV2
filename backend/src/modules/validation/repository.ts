// Shared data access for Baseline Manifest + Validation Run (P2-D —
// minimal Structural Validation). Schema facts below were read
// directly off Supabase Cloud (pg_attribute/pg_constraint/pg_trigger/
// pg_get_functiondef), not assumed from the Data Dictionary - see
// migrations/013_grant_validation_infra.sql's comment for the full
// verification record and trigger behavior this module's write order
// depends on.

import type { PoolClient } from "pg";
import { getPool } from "../../db/pool.js";

export interface BaselineManifestRow {
  manifest_id: string;
  case_id: string;
  manifest_purpose: string;
  manifest_status: string;
  frozen_at: string | null;
  manifest_sha256: string | null;
  created_at: string;
  created_by: string;
}

export async function insertDraftManifest(
  client: PoolClient,
  params: { caseId: string; manifestPurpose: string; createdBy: string },
): Promise<BaselineManifestRow> {
  const { rows } = await client.query<BaselineManifestRow>(
    `INSERT INTO baseline_manifests (case_id, manifest_purpose, manifest_status, created_by)
     VALUES ($1, $2, 'DRAFT', $3)
     RETURNING manifest_id, case_id, manifest_purpose, manifest_status, frozen_at,
               manifest_sha256, created_at, created_by`,
    [params.caseId, params.manifestPurpose, params.createdBy],
  );
  return rows[0]!;
}

// Must run AFTER every manifest_items row has already been inserted -
// rt_guard_manifest_item rejects any further INSERT/UPDATE/DELETE on
// manifest_items once manifest_status = 'FROZEN' (see migration 013's
// comment), so this is deliberately the last write against a manifest
// inside its creating transaction.
export async function freezeManifest(
  client: PoolClient,
  params: { manifestId: string; manifestSha256: string },
): Promise<BaselineManifestRow | null> {
  const { rows } = await client.query<BaselineManifestRow>(
    `UPDATE baseline_manifests
     SET manifest_status = 'FROZEN', frozen_at = now(), manifest_sha256 = $2
     WHERE manifest_id = $1
     RETURNING manifest_id, case_id, manifest_purpose, manifest_status, frozen_at,
               manifest_sha256, created_at, created_by`,
    [params.manifestId, params.manifestSha256],
  );
  return rows[0] ?? null;
}

export interface ManifestItemRow {
  manifest_item_id: string;
  manifest_id: string;
  item_kind: string;
  entity_revision_id: string | null;
  relation_revision_id: string | null;
  publication_id: string | null;
  membership_role: string;
  sort_order: number;
  item_notes: string | null;
}

/**
 * Inserts one ENTITY_REVISION manifest item pinning a specific
 * entity_revisions row. membershipRole defaults to 'INCLUDED' (P2-D's
 * original Structural Validation usage, pinning each Requirement's
 * current revision as plain input). The Document/Confirmation module
 * (Phase 6 P3) passes 'CONFIRMABLE' instead, since
 * rt_guard_confirmation_scope requires that exact membership_role for
 * any manifest_item a CustomerConfirmation can reference. RELATION_
 * REVISION and PUBLICATION are valid item_kind values per the schema's
 * own CHECK but have no caller anywhere in this codebase yet.
 */
export async function insertEntityRevisionManifestItem(
  client: PoolClient,
  params: {
    manifestId: string;
    entityRevisionId: string;
    sortOrder: number;
    membershipRole?: "INCLUDED" | "REFERENCED_ONLY" | "CONFIRMABLE" | "HANDOFF_ARTIFACT";
    // B2.2 provenance representation: free-text reasoning for why this
    // item is in the manifest (e.g. "REFERENCED_ONLY via
    // RULE_APPLIES_TO_REQUIREMENT from <entity_id> (relation
    // <relation_id>, relation_revision <relation_revision_id>)").
    // item_notes is the only column available for this on an
    // ENTITY_REVISION-kind row - manifest_items_check forbids setting
    // relation_revision_id on a row whose item_kind is 'ENTITY_REVISION'
    // (that column is reserved for item_kind='RELATION_REVISION' rows,
    // which no caller in this codebase creates), so the relation
    // instance/revision that justified a REFERENCED_ONLY item cannot be
    // stored as a structured FK here without a schema change - see
    // dependency-closure.ts's ReferencedOnlyEntity for where that same
    // information IS available in structured form, for any caller that
    // needs it before persistence (e.g. B2.2's source eligibility
    // findings).
    itemNotes?: string | null;
  },
): Promise<ManifestItemRow> {
  const { rows } = await client.query<ManifestItemRow>(
    `INSERT INTO manifest_items
       (manifest_id, item_kind, entity_revision_id, membership_role, sort_order, item_notes)
     VALUES ($1, 'ENTITY_REVISION', $2, $3, $4, $5)
     RETURNING manifest_item_id, manifest_id, item_kind, entity_revision_id,
               relation_revision_id, publication_id, membership_role, sort_order, item_notes`,
    [
      params.manifestId,
      params.entityRevisionId,
      params.membershipRole ?? "INCLUDED",
      params.sortOrder,
      params.itemNotes ?? null,
    ],
  );
  return rows[0]!;
}

/**
 * Inserts one PUBLICATION-kind manifest item, pinning a specific
 * document_publications row. Used by the Handoff module (Phase 6 P3)
 * to bundle the exact publications a HANDOFF-purpose manifest
 * includes, per the Data Dictionary's own note on HandoffBaseline
 * ("bundle manifest includes publication artifacts").
 */
export async function insertPublicationManifestItem(
  client: PoolClient,
  params: {
    manifestId: string;
    publicationId: string;
    sortOrder: number;
    membershipRole?: "INCLUDED" | "REFERENCED_ONLY" | "CONFIRMABLE" | "HANDOFF_ARTIFACT";
  },
): Promise<ManifestItemRow> {
  const { rows } = await client.query<ManifestItemRow>(
    `INSERT INTO manifest_items
       (manifest_id, item_kind, publication_id, membership_role, sort_order)
     VALUES ($1, 'PUBLICATION', $2, $3, $4)
     RETURNING manifest_item_id, manifest_id, item_kind, entity_revision_id,
               relation_revision_id, publication_id, membership_role, sort_order, item_notes`,
    [params.manifestId, params.publicationId, params.membershipRole ?? "HANDOFF_ARTIFACT", params.sortOrder],
  );
  return rows[0]!;
}

export interface ConfirmableManifestItemRow {
  manifest_item_id: string;
  entity_revision_id: string | null;
}

/**
 * Lists the manifest_items of a manifest whose membership_role is
 * 'CONFIRMABLE' - this IS confirmation eligibility under the approved
 * convention (no separate table): a scope item is either INCLUDED
 * (part of the document scope, not individually confirmable) or
 * CONFIRMABLE (part of the document scope AND eligible for a
 * ConfirmationScopeItem to reference) - the two are mutually exclusive
 * values of the same column, chosen once when the item is created by
 * createSnapshotService (see that function's confirmable_entity_ids
 * parameter). Used to show a BA which manifest_item_id values a
 * ConfirmationScopeItem may legally reference for a given snapshot,
 * without the client having to already know manifest internals.
 */
export async function findConfirmableManifestItemsByManifestId(
  manifestId: string,
): Promise<ConfirmableManifestItemRow[]> {
  const { rows } = await getPool().query<ConfirmableManifestItemRow>(
    `SELECT manifest_item_id, entity_revision_id
     FROM manifest_items
     WHERE manifest_id = $1 AND item_kind = 'ENTITY_REVISION' AND membership_role = 'CONFIRMABLE'
     ORDER BY sort_order ASC`,
    [manifestId],
  );
  return rows;
}

/**
 * Lists every ENTITY_REVISION manifest_items row for a manifest,
 * regardless of membership_role - used by B2.1 (dependency closure)
 * callers/tests that need to see the full INCLUDED/CONFIRMABLE/
 * REFERENCED_ONLY classification of a frozen manifest, not just the
 * CONFIRMABLE subset findConfirmableManifestItemsByManifestId already
 * serves. Not currently exposed via any route - internal read used by
 * the B2.1 integration test; add a route only if a real caller needs
 * one.
 */
export async function findManifestItemsByManifestId(
  manifestId: string,
): Promise<ManifestItemRow[]> {
  const { rows } = await getPool().query<ManifestItemRow>(
    `SELECT manifest_item_id, manifest_id, item_kind, entity_revision_id,
            relation_revision_id, publication_id, membership_role, sort_order, item_notes
     FROM manifest_items
     WHERE manifest_id = $1
     ORDER BY sort_order ASC`,
    [manifestId],
  );
  return rows;
}

/**
 * Resolves the current (highest revision_no) entity_revisions row for
 * a given entity_id. Used to pin "the Requirement as it exists right
 * now" into the manifest, and (for Discovery Answer / Information Gap
 * findings) to record which revision a validation_results row's
 * target_entity_revision_id points at.
 *
 * `client` (B2.3): optional - pass the active transaction's
 * PoolClient to run this query on that same connection/transaction
 * instead of a fresh one from the pool. This matters specifically for
 * createSnapshotService's consistency re-check (documents/service.ts):
 * calling this WITHOUT a client there would run the re-check on a
 * different connection than the one about to perform the INSERTs,
 * which does not actually run "inside" that transaction in any
 * meaningful sense despite being lexically nested inside
 * withTransaction's callback - see that call site's own comment for
 * exactly what guarantee passing `client` does and does not provide
 * (no table-level or row-level lock is taken here; this is a
 * detect-and-reject re-read, not a lock that blocks a concurrent
 * writer, since entity_revisions is append-only and a concurrent
 * writer is never locking the same not-yet-existing row).
 */
export async function findCurrentEntityRevisionId(
  entityId: string,
  client?: PoolClient,
): Promise<string | null> {
  const { rows } = await (client ?? getPool()).query<{ entity_revision_id: string }>(
    `SELECT entity_revision_id FROM entity_revisions
     WHERE entity_id = $1
     ORDER BY revision_no DESC
     LIMIT 1`,
    [entityId],
  );
  return rows[0]?.entity_revision_id ?? null;
}

export interface ValidationRunRow {
  validation_run_id: string;
  case_id: string;
  manifest_id: string;
  policy_version_id: string;
  run_status: string;
  started_at: string;
  completed_at: string | null;
  triggered_by: string;
  execution_context: unknown;
}

export async function insertRunningValidationRun(
  client: PoolClient,
  params: { caseId: string; manifestId: string; policyVersionId: string; triggeredBy: string },
): Promise<ValidationRunRow> {
  const { rows } = await client.query<ValidationRunRow>(
    `INSERT INTO validation_runs
       (case_id, manifest_id, policy_version_id, run_status, started_at, triggered_by)
     VALUES ($1, $2, $3, 'RUNNING', now(), $4)
     RETURNING validation_run_id, case_id, manifest_id, policy_version_id, run_status,
               started_at, completed_at, triggered_by, execution_context`,
    [params.caseId, params.manifestId, params.policyVersionId, params.triggeredBy],
  );
  return rows[0]!;
}

export async function completeValidationRun(
  client: PoolClient,
  params: { validationRunId: string; runStatus: "COMPLETED" | "FAILED_TO_RUN" },
): Promise<ValidationRunRow | null> {
  const { rows } = await client.query<ValidationRunRow>(
    `UPDATE validation_runs
     SET run_status = $2, completed_at = now()
     WHERE validation_run_id = $1
     RETURNING validation_run_id, case_id, manifest_id, policy_version_id, run_status,
               started_at, completed_at, triggered_by, execution_context`,
    [params.validationRunId, params.runStatus],
  );
  return rows[0] ?? null;
}

export async function findValidationRunById(
  validationRunId: string,
): Promise<ValidationRunRow | null> {
  const { rows } = await getPool().query<ValidationRunRow>(
    `SELECT validation_run_id, case_id, manifest_id, policy_version_id, run_status,
            started_at, completed_at, triggered_by, execution_context
     FROM validation_runs
     WHERE validation_run_id = $1`,
    [validationRunId],
  );
  return rows[0] ?? null;
}

export async function findValidationRunsByCaseId(caseId: string): Promise<ValidationRunRow[]> {
  const { rows } = await getPool().query<ValidationRunRow>(
    `SELECT validation_run_id, case_id, manifest_id, policy_version_id, run_status,
            started_at, completed_at, triggered_by, execution_context
     FROM validation_runs
     WHERE case_id = $1
     ORDER BY started_at DESC`,
    [caseId],
  );
  return rows;
}

export interface ValidationResultRow {
  validation_result_id: string;
  validation_run_id: string;
  check_definition_version_id: string;
  target_entity_revision_id: string | null;
  result_outcome: string;
  execution_status: string;
  finding_summary: string | null;
  severity: string | null;
  ai_confidence: number | null;
  result_details: unknown;
  evaluated_at: string;
}

export async function insertValidationResult(
  client: PoolClient,
  params: {
    validationRunId: string;
    checkDefinitionVersionId: string;
    targetEntityRevisionId: string | null;
    resultOutcome: "PASS" | "FAIL" | "UNKNOWN" | "N_A" | "WARNING";
    findingSummary: string | null;
    severity: string | null;
    resultDetails: unknown;
  },
): Promise<ValidationResultRow> {
  const { rows } = await client.query<ValidationResultRow>(
    `INSERT INTO validation_results
       (validation_run_id, check_definition_version_id, target_entity_revision_id,
        result_outcome, execution_status, finding_summary, severity, result_details, evaluated_at)
     VALUES ($1, $2, $3, $4, 'EXECUTED', $5, $6, $7::jsonb, now())
     RETURNING validation_result_id, validation_run_id, check_definition_version_id,
               target_entity_revision_id, result_outcome, execution_status, finding_summary,
               severity, ai_confidence, result_details, evaluated_at`,
    [
      params.validationRunId,
      params.checkDefinitionVersionId,
      params.targetEntityRevisionId,
      params.resultOutcome,
      params.findingSummary,
      params.severity,
      JSON.stringify(params.resultDetails ?? null),
    ],
  );
  return rows[0]!;
}

export async function findValidationResultsByRunId(
  validationRunId: string,
): Promise<ValidationResultRow[]> {
  const { rows } = await getPool().query<ValidationResultRow>(
    `SELECT validation_result_id, validation_run_id, check_definition_version_id,
            target_entity_revision_id, result_outcome, execution_status, finding_summary,
            severity, ai_confidence, result_details, evaluated_at
     FROM validation_results
     WHERE validation_run_id = $1
     ORDER BY evaluated_at ASC`,
    [validationRunId],
  );
  return rows;
}

/**
 * Returns the EFFECTIVE result per check_definition_version_id for a
 * run - the most recently evaluated_at row for each check, which may
 * be a later human-reviewed row superseding an earlier deterministic
 * or UNKNOWN one. Older rows are never deleted or updated (see
 * recordHumanReviewedResultService in service.ts) - this query is the
 * only place "which result currently applies" is computed, so every
 * caller (Completeness/Quality Assessment, Readiness) reads the same
 * effective view instead of re-implementing this logic.
 */
export async function findEffectiveResultsByRunId(
  validationRunId: string,
): Promise<ValidationResultRow[]> {
  const { rows } = await getPool().query<ValidationResultRow>(
    `SELECT DISTINCT ON (check_definition_version_id, target_entity_revision_id)
            validation_result_id, validation_run_id, check_definition_version_id,
            target_entity_revision_id, result_outcome, execution_status, finding_summary,
            severity, ai_confidence, result_details, evaluated_at
     FROM validation_results
     WHERE validation_run_id = $1
     ORDER BY check_definition_version_id, target_entity_revision_id, evaluated_at DESC`,
    [validationRunId],
  );
  return rows;
}

// --- Structural check #1: Requirement must have >= 1 Acceptance Criteria ---

export interface RequirementForCheck {
  requirement_id: string;
  requirement_code: string;
  ac_count: number;
}

export async function findRequirementsWithAcCount(caseId: string): Promise<RequirementForCheck[]> {
  const { rows } = await getPool().query<RequirementForCheck>(
    `SELECT r.requirement_id, r.requirement_code,
            count(ac.ac_id)::int AS ac_count
     FROM requirements r
     LEFT JOIN acceptance_criteria ac ON ac.requirement_id = r.requirement_id
     WHERE r.case_id = $1
     GROUP BY r.requirement_id, r.requirement_code
     ORDER BY r.requirement_code ASC`,
    [caseId],
  );
  return rows;
}

// --- Structural check #2: Discovery Answer must not be UNKNOWN when its Module Application is COMPLETED ---

export interface UnknownAnswerForCheck {
  answer_id: string;
  module_application_id: string;
  question_definition_version_id: string;
}

export async function findUnknownAnswersOnCompletedModules(
  caseId: string,
): Promise<UnknownAnswerForCheck[]> {
  const { rows } = await getPool().query<UnknownAnswerForCheck>(
    `SELECT da.answer_id, da.module_application_id, da.question_definition_version_id
     FROM discovery_answers da
     JOIN module_applications ma ON ma.module_application_id = da.module_application_id
     WHERE da.case_id = $1
       AND ma.application_status = 'COMPLETED'
       AND da.answer_status = 'UNKNOWN'
     ORDER BY da.recorded_at ASC`,
    [caseId],
  );
  return rows;
}

// --- Structural check #3: Information Gap still OPEN/CLARIFYING ---

export interface OpenGapForCheck {
  gap_id: string;
  gap_status: string;
  gap_summary: string;
}

export async function findOpenOrClarifyingGaps(caseId: string): Promise<OpenGapForCheck[]> {
  const { rows } = await getPool().query<OpenGapForCheck>(
    `SELECT gap_id, gap_status, gap_summary
     FROM information_gaps
     WHERE case_id = $1
       AND gap_status IN ('OPEN', 'CLARIFYING')
     ORDER BY created_at ASC`,
    [caseId],
  );
  return rows;
}

// --- Check #4: Evidence Coverage Confirmed (Framework 0.6) ---
// Only Business Decisions that DO cite a source_evidence_id are
// in scope - a Decision with none is N/A for this check, never FAIL,
// since not every Decision is required to cite Evidence.

export interface DecisionEvidenceCoverageForCheck {
  decision_id: string;
  decision_subject: string;
  source_evidence_id: string;
  evidence_status: string;
}

export async function findDecisionsWithEvidenceCoverage(
  caseId: string,
): Promise<DecisionEvidenceCoverageForCheck[]> {
  const { rows } = await getPool().query<DecisionEvidenceCoverageForCheck>(
    `SELECT bd.decision_id, bd.decision_subject, bd.source_evidence_id, e.evidence_status
     FROM business_decisions bd
     JOIN evidence e ON e.evidence_id = bd.source_evidence_id
     WHERE bd.case_id = $1
       AND bd.source_evidence_id IS NOT NULL
     ORDER BY bd.created_at ASC`,
    [caseId],
  );
  return rows;
}

// --- Check #5: Dependency Blocker Recorded (DEP-CHK-03) ---
// Checks only that a BLOCKER-type Issue, if any exists, carries a
// recognized issue_status - NOT whether it has been resolved. issues
// has no DB CHECK on issue_status (free text), so "recognized" is
// validated against this service's own whitelist (see service.ts),
// matching issue_status NOT NULL's own guarantee that *some* value is
// always present - this check still verifies it is one of the
// documented vocabulary values, not just non-null.

export interface BlockerIssueForCheck {
  issue_id: string;
  issue_code: string;
  issue_status: string;
}

export interface CheckRuleWithReviewMode {
  definition_version_id: string;
  review_mode: string;
}

export interface CheckRuleMeta {
  definition_version_id: string;
  definition_code: string;
  review_mode: string | null;
  obligation_level: string | null;
}

/**
 * Returns every ACTIVE CHECK_RULE's definition_code, review_mode, and
 * obligation_level, keyed for lookup by definition_version_id - used
 * by Quality Gate aggregation (src/modules/assessment/service.ts) to
 * classify each validation_results row's check without a per-row N+1
 * query.
 */
export async function findAllActiveCheckRuleMeta(): Promise<CheckRuleMeta[]> {
  const { rows } = await getPool().query<CheckRuleMeta>(
    `SELECT definition_version_id, definition_code,
            definition_body->>'review_mode' AS review_mode,
            definition_body->>'obligation_level' AS obligation_level
     FROM definition_versions
     WHERE definition_type = 'CHECK_RULE' AND status = 'ACTIVE'`,
  );
  return rows;
}

/**
 * Resolves an ACTIVE CHECK_RULE by code along with its
 * definition_body.review_mode (DETERMINISTIC or HUMAN_REVIEWED, seeded
 * by migrations 013/014) - used by recordHumanReviewedResultService to
 * refuse overriding a DETERMINISTIC check's automatic result.
 */
export async function findCheckRuleWithReviewMode(
  checkRuleCode: string,
): Promise<CheckRuleWithReviewMode | null> {
  const { rows } = await getPool().query<CheckRuleWithReviewMode>(
    `SELECT definition_version_id, definition_body->>'review_mode' AS review_mode
     FROM definition_versions
     WHERE definition_type = 'CHECK_RULE' AND definition_code = $1 AND status = 'ACTIVE'`,
    [checkRuleCode],
  );
  return rows[0] ?? null;
}

export async function findBlockerIssuesForCheck(caseId: string): Promise<BlockerIssueForCheck[]> {
  const { rows } = await getPool().query<BlockerIssueForCheck>(
    `SELECT issue_id, issue_code, issue_status
     FROM issues
     WHERE case_id = $1 AND issue_type = 'BLOCKER'
     ORDER BY opened_at ASC`,
    [caseId],
  );
  return rows;
}
