import type { PoolClient } from "pg";
import { getPool } from "../../db/pool.js";

export interface CaseScopeRow {
  scope_id: string;
  case_id: string;
  scope_name: string;
  in_scope: string;
  out_of_scope: string | null;
  boundary_notes: string | null;
  constraints_json: unknown;
  current_revision_no: number;
  scope_status: string;
  updated_at: string;
}

// One Case has at most one "current" CaseScope row per the Data
// Dictionary's design (no case_id uniqueness constraint in the DB,
// but FR-002/026 describe scope as a single versioned object per
// Case, not a list) - find the most recently updated row for the
// Case rather than assuming exactly one exists.
export async function findScopeByCaseId(caseId: string): Promise<CaseScopeRow | null> {
  const { rows } = await getPool().query<CaseScopeRow>(
    `SELECT scope_id, case_id, scope_name, in_scope, out_of_scope, boundary_notes,
            constraints_json, current_revision_no, scope_status, updated_at
     FROM case_scopes
     WHERE case_id = $1
     ORDER BY updated_at DESC
     LIMIT 1`,
    [caseId],
  );
  return rows[0] ?? null;
}

export async function insertScope(
  client: PoolClient,
  params: {
    scopeId: string;
    caseId: string;
    scopeName: string;
    inScope: string;
    outOfScope: string | null;
    boundaryNotes: string | null;
    constraintsJson: unknown;
  },
): Promise<CaseScopeRow> {
  const { rows } = await client.query<CaseScopeRow>(
    `INSERT INTO case_scopes
       (scope_id, case_id, scope_name, in_scope, out_of_scope, boundary_notes, constraints_json)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
     RETURNING scope_id, case_id, scope_name, in_scope, out_of_scope, boundary_notes,
               constraints_json, current_revision_no, scope_status, updated_at`,
    [
      params.scopeId,
      params.caseId,
      params.scopeName,
      params.inScope,
      params.outOfScope,
      params.boundaryNotes,
      JSON.stringify(params.constraintsJson ?? []),
    ],
  );
  return rows[0]!;
}

export async function updateScope(
  client: PoolClient,
  params: {
    scopeId: string;
    scopeName: string;
    inScope: string;
    outOfScope: string | null;
    boundaryNotes: string | null;
    constraintsJson: unknown;
    scopeStatus: string;
    newRevisionNo: number;
  },
): Promise<CaseScopeRow | null> {
  const { rows } = await client.query<CaseScopeRow>(
    `UPDATE case_scopes
     SET scope_name = $2, in_scope = $3, out_of_scope = $4, boundary_notes = $5,
         constraints_json = $6::jsonb, scope_status = $7, current_revision_no = $8,
         updated_at = now()
     WHERE scope_id = $1
     RETURNING scope_id, case_id, scope_name, in_scope, out_of_scope, boundary_notes,
               constraints_json, current_revision_no, scope_status, updated_at`,
    [
      params.scopeId,
      params.scopeName,
      params.inScope,
      params.outOfScope,
      params.boundaryNotes,
      JSON.stringify(params.constraintsJson ?? []),
      params.scopeStatus,
      params.newRevisionNo,
    ],
  );
  return rows[0] ?? null;
}
