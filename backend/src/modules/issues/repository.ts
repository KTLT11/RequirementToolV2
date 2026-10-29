import type { PoolClient } from "pg";
import { getPool } from "../../db/pool.js";

export interface IssueRow {
  issue_id: string;
  case_id: string;
  issue_code: string;
  issue_subject: string;
  issue_type: string;
  issue_status: string;
  severity: string | null;
  assignee_user_id: string | null;
  source_check_result_id: string | null;
  current_revision_no: number;
  opened_at: string;
  closed_at: string | null;
}

export async function findIssuesByCaseId(
  caseId: string,
  statusFilter: string | null,
): Promise<IssueRow[]> {
  const values: unknown[] = [caseId];
  let whereClause = "WHERE case_id = $1";
  if (statusFilter) {
    values.push(statusFilter);
    whereClause += ` AND issue_status = $${values.length}`;
  }

  const { rows } = await getPool().query<IssueRow>(
    `SELECT issue_id, case_id, issue_code, issue_subject, issue_type, issue_status,
            severity, assignee_user_id, source_check_result_id, current_revision_no,
            opened_at, closed_at
     FROM issues
     ${whereClause}
     ORDER BY opened_at ASC`,
    values,
  );
  return rows;
}

export async function findIssueById(issueId: string): Promise<IssueRow | null> {
  const { rows } = await getPool().query<IssueRow>(
    `SELECT issue_id, case_id, issue_code, issue_subject, issue_type, issue_status,
            severity, assignee_user_id, source_check_result_id, current_revision_no,
            opened_at, closed_at
     FROM issues
     WHERE issue_id = $1`,
    [issueId],
  );
  return rows[0] ?? null;
}

export async function issueCodeExists(caseId: string, issueCode: string): Promise<boolean> {
  const { rows } = await getPool().query<{ exists: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM issues WHERE case_id = $1 AND issue_code = $2) AS exists`,
    [caseId, issueCode],
  );
  return rows[0]?.exists ?? false;
}

export async function insertIssue(
  client: PoolClient,
  params: {
    issueId: string; // == entity_id, registered by the caller first
    caseId: string;
    issueCode: string;
    issueSubject: string;
    issueType: string;
    severity: string | null;
    assigneeUserId: string | null;
    sourceCheckResultId: string | null;
  },
): Promise<IssueRow> {
  const { rows } = await client.query<IssueRow>(
    `INSERT INTO issues
       (issue_id, case_id, issue_code, issue_subject, issue_type, severity,
        assignee_user_id, source_check_result_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING issue_id, case_id, issue_code, issue_subject, issue_type, issue_status,
               severity, assignee_user_id, source_check_result_id, current_revision_no,
               opened_at, closed_at`,
    [
      params.issueId,
      params.caseId,
      params.issueCode,
      params.issueSubject,
      params.issueType,
      params.severity,
      params.assigneeUserId,
      params.sourceCheckResultId,
    ],
  );
  return rows[0]!;
}

export async function updateIssue(
  client: PoolClient,
  params: {
    issueId: string;
    issueSubject: string;
    issueStatus: string;
    severity: string | null;
    assigneeUserId: string | null;
    closedAt: string | null;
    newRevisionNo: number;
  },
): Promise<IssueRow | null> {
  const { rows } = await client.query<IssueRow>(
    `UPDATE issues
     SET issue_subject = $2, issue_status = $3, severity = $4, assignee_user_id = $5,
         closed_at = $6, current_revision_no = $7
     WHERE issue_id = $1
     RETURNING issue_id, case_id, issue_code, issue_subject, issue_type, issue_status,
               severity, assignee_user_id, source_check_result_id, current_revision_no,
               opened_at, closed_at`,
    [
      params.issueId,
      params.issueSubject,
      params.issueStatus,
      params.severity,
      params.assigneeUserId,
      params.closedAt,
      params.newRevisionNo,
    ],
  );
  return rows[0] ?? null;
}

export interface IssueResolutionRow {
  resolution_id: string;
  issue_id: string;
  resolution_method: string;
  resolution_summary: string;
  verification_outcome: string;
  verification_result_id: string | null;
  resolution_evidence_id: string | null;
  resolution_decision_id: string | null;
  verified_at: string;
  verified_by: string;
}

export async function insertIssueResolution(
  client: PoolClient,
  params: {
    issueId: string;
    resolutionMethod: string;
    resolutionSummary: string;
    verificationOutcome: string;
    verificationResultId: string | null;
    resolutionEvidenceId: string | null;
    resolutionDecisionId: string | null;
    verifiedAt: string;
    verifiedBy: string;
  },
): Promise<IssueResolutionRow> {
  const { rows } = await client.query<IssueResolutionRow>(
    `INSERT INTO issue_resolutions
       (issue_id, resolution_method, resolution_summary, verification_outcome,
        verification_result_id, resolution_evidence_id, resolution_decision_id,
        verified_at, verified_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING resolution_id, issue_id, resolution_method, resolution_summary,
               verification_outcome, verification_result_id, resolution_evidence_id,
               resolution_decision_id, verified_at, verified_by`,
    [
      params.issueId,
      params.resolutionMethod,
      params.resolutionSummary,
      params.verificationOutcome,
      params.verificationResultId,
      params.resolutionEvidenceId,
      params.resolutionDecisionId,
      params.verifiedAt,
      params.verifiedBy,
    ],
  );
  return rows[0]!;
}

export async function findResolutionsByIssueId(issueId: string): Promise<IssueResolutionRow[]> {
  const { rows } = await getPool().query<IssueResolutionRow>(
    `SELECT resolution_id, issue_id, resolution_method, resolution_summary,
            verification_outcome, verification_result_id, resolution_evidence_id,
            resolution_decision_id, verified_at, verified_by
     FROM issue_resolutions
     WHERE issue_id = $1
     ORDER BY verified_at ASC`,
    [issueId],
  );
  return rows;
}

// --- Used by Readiness Assessment (DEP-CHK-03 / 4.3 Readiness Classification) ---

export interface OpenBlockerForCase {
  issue_id: string;
  issue_code: string;
  issue_subject: string;
  issue_status: string;
}

/**
 * Open/unresolved BLOCKER-type issues for a Case - "open" here means
 * issue_status NOT IN ('RESOLVED') and closed_at IS NULL, matching the
 * schema's own closed_at semantics (issues_check CHECK requires
 * closed_at >= opened_at, implying closed_at is set exactly when the
 * issue is actually closed, regardless of which status label a future
 * caller uses for "closed"). Used by Readiness Classification to
 * decide Ready vs Ready but Blocked - NOT the same question as
 * DEP_BLOCKER_RECORDED (which only checks a blocker has *some* status
 * recorded, not whether it's still open).
 */
export async function findOpenBlockerIssues(caseId: string): Promise<OpenBlockerForCase[]> {
  const { rows } = await getPool().query<OpenBlockerForCase>(
    `SELECT issue_id, issue_code, issue_subject, issue_status
     FROM issues
     WHERE case_id = $1
       AND issue_type = 'BLOCKER'
       AND closed_at IS NULL
     ORDER BY opened_at ASC`,
    [caseId],
  );
  return rows;
}

export async function findBlockerIssuesByCaseId(caseId: string): Promise<OpenBlockerForCase[]> {
  const { rows } = await getPool().query<OpenBlockerForCase>(
    `SELECT issue_id, issue_code, issue_subject, issue_status
     FROM issues
     WHERE case_id = $1
       AND issue_type = 'BLOCKER'
     ORDER BY opened_at ASC`,
    [caseId],
  );
  return rows;
}
