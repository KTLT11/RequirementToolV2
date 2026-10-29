import type { PoolClient } from "pg";
import { getPool } from "../../db/pool.js";

export interface CaseStakeholderRow {
  case_stakeholder_id: string;
  case_id: string;
  stakeholder_id: string;
  participation_status: string;
  joined_at: string;
  ended_at: string | null;
  notes: string | null;
}

export interface RoleAssignmentRow {
  role_assignment_id: string;
  case_stakeholder_id: string;
  role_code: string;
  valid_from: string;
  valid_to: string | null;
  assigned_at: string;
  assigned_by: string;
}

export interface AuthorityAssignmentRow {
  authority_id: string;
  case_stakeholder_id: string;
  role_assignment_id: string | null;
  authority_type: string;
  permitted_action: string;
  scope_entity_id: string | null;
  scope_notes: string | null;
  valid_from: string;
  valid_to: string | null;
  verification_status: string;
  verified_by: string | null;
}

export async function findCaseStakeholdersByCaseId(caseId: string): Promise<CaseStakeholderRow[]> {
  const { rows } = await getPool().query<CaseStakeholderRow>(
    `SELECT case_stakeholder_id, case_id, stakeholder_id, participation_status,
            joined_at, ended_at, notes
     FROM case_stakeholders
     WHERE case_id = $1
     ORDER BY joined_at ASC`,
    [caseId],
  );
  return rows;
}

export async function findCaseStakeholderById(
  caseStakeholderId: string,
): Promise<CaseStakeholderRow | null> {
  const { rows } = await getPool().query<CaseStakeholderRow>(
    `SELECT case_stakeholder_id, case_id, stakeholder_id, participation_status,
            joined_at, ended_at, notes
     FROM case_stakeholders
     WHERE case_stakeholder_id = $1`,
    [caseStakeholderId],
  );
  return rows[0] ?? null;
}

export async function insertCaseStakeholder(
  client: PoolClient,
  params: { caseId: string; stakeholderId: string; notes: string | null },
): Promise<CaseStakeholderRow> {
  const { rows } = await client.query<CaseStakeholderRow>(
    `INSERT INTO case_stakeholders (case_id, stakeholder_id, notes)
     VALUES ($1, $2, $3)
     RETURNING case_stakeholder_id, case_id, stakeholder_id, participation_status,
               joined_at, ended_at, notes`,
    [params.caseId, params.stakeholderId, params.notes],
  );
  return rows[0]!;
}

export async function insertRoleAssignment(
  client: PoolClient,
  params: { caseStakeholderId: string; roleCode: string; assignedBy: string },
): Promise<RoleAssignmentRow> {
  const { rows } = await client.query<RoleAssignmentRow>(
    `INSERT INTO role_assignments (case_stakeholder_id, role_code, assigned_by)
     VALUES ($1, $2, $3)
     RETURNING role_assignment_id, case_stakeholder_id, role_code, valid_from,
               valid_to, assigned_at, assigned_by`,
    [params.caseStakeholderId, params.roleCode, params.assignedBy],
  );
  return rows[0]!;
}

export async function findRoleAssignmentsByCaseStakeholderId(
  caseStakeholderId: string,
): Promise<RoleAssignmentRow[]> {
  const { rows } = await getPool().query<RoleAssignmentRow>(
    `SELECT role_assignment_id, case_stakeholder_id, role_code, valid_from,
            valid_to, assigned_at, assigned_by
     FROM role_assignments
     WHERE case_stakeholder_id = $1
     ORDER BY assigned_at ASC`,
    [caseStakeholderId],
  );
  return rows;
}

/**
 * Looks up a specific role_assignment, scoped to the same
 * case_stakeholder - mirrors the composite FK
 * authority_assignments(role_assignment_id, case_stakeholder_id) ->
 * role_assignments(role_assignment_id, case_stakeholder_id), so this
 * query is what determines whether a given role assignment is even
 * eligible to be referenced from a new authority grant for that
 * stakeholder.
 */
export async function findRoleAssignment(
  roleAssignmentId: string,
  caseStakeholderId: string,
): Promise<RoleAssignmentRow | null> {
  const { rows } = await getPool().query<RoleAssignmentRow>(
    `SELECT role_assignment_id, case_stakeholder_id, role_code, valid_from,
            valid_to, assigned_at, assigned_by
     FROM role_assignments
     WHERE role_assignment_id = $1 AND case_stakeholder_id = $2`,
    [roleAssignmentId, caseStakeholderId],
  );
  return rows[0] ?? null;
}

export async function insertAuthorityAssignment(
  client: PoolClient,
  params: {
    caseStakeholderId: string;
    roleAssignmentId: string | null;
    authorityType: string;
    permittedAction: string;
    scopeEntityId: string | null;
    scopeNotes: string | null;
    validFrom: string;
    validTo: string | null;
    verificationStatus: string;
    verifiedBy: string | null;
  },
): Promise<AuthorityAssignmentRow> {
  const { rows } = await client.query<AuthorityAssignmentRow>(
    `INSERT INTO authority_assignments
       (case_stakeholder_id, role_assignment_id, authority_type, permitted_action,
        scope_entity_id, scope_notes, valid_from, valid_to, verification_status, verified_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING authority_id, case_stakeholder_id, role_assignment_id, authority_type,
               permitted_action, scope_entity_id, scope_notes, valid_from, valid_to,
               verification_status, verified_by`,
    [
      params.caseStakeholderId,
      params.roleAssignmentId,
      params.authorityType,
      params.permittedAction,
      params.scopeEntityId,
      params.scopeNotes,
      params.validFrom,
      params.validTo,
      params.verificationStatus,
      params.verifiedBy,
    ],
  );
  return rows[0]!;
}

export async function findAuthorityById(authorityId: string): Promise<AuthorityAssignmentRow | null> {
  const { rows } = await getPool().query<AuthorityAssignmentRow>(
    `SELECT authority_id, case_stakeholder_id, role_assignment_id, authority_type,
            permitted_action, scope_entity_id, scope_notes, valid_from, valid_to,
            verification_status, verified_by
     FROM authority_assignments
     WHERE authority_id = $1`,
    [authorityId],
  );
  return rows[0] ?? null;
}

/**
 * Checks whether an authority grant is currently in effect (used by
 * Evidence Confirmation, P2-B, to enforce "Evidence Confirmed must
 * have an authority" per FR-014 AC-03). Deliberately does not check
 * verification_status itself here - whether an unverified authority
 * can still confirm evidence is a business decision outside this
 * query's job; callers decide whether to also require
 * verification_status.
 */
export async function isAuthorityCurrentlyValid(authorityId: string): Promise<boolean> {
  const { rows } = await getPool().query<{ valid: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM authority_assignments
       WHERE authority_id = $1
         AND valid_from <= now()
         AND (valid_to IS NULL OR valid_to > now())
     ) AS valid`,
    [authorityId],
  );
  return rows[0]?.valid ?? false;
}
