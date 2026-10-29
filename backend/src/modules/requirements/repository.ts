import type { PoolClient } from "pg";
import { getPool } from "../../db/pool.js";

export interface RequirementRow {
  requirement_id: string;
  case_id: string;
  requirement_code: string;
  requirement_type: string;
  title: string;
  statement: string;
  rationale: string | null;
  lifecycle_status: string;
  priority: string | null;
  // B1.3 Structured Semantic Data - opaque to this layer. Service.ts
  // is the only place that knows/validates its shape
  // ({ profile_version, functional?, nfr?, reporting? }); repository
  // just stores and returns whatever JSON value it was given.
  structured_detail: unknown | null;
  current_revision_no: number;
  created_at: string;
  updated_at: string;
}

const REQUIREMENT_COLUMNS = `requirement_id, case_id, requirement_code, requirement_type, title,
            statement, rationale, lifecycle_status, priority, structured_detail,
            current_revision_no, created_at, updated_at`;

export async function findRequirementsByCaseId(caseId: string): Promise<RequirementRow[]> {
  const { rows } = await getPool().query<RequirementRow>(
    `SELECT ${REQUIREMENT_COLUMNS}
     FROM requirements
     WHERE case_id = $1
     ORDER BY created_at ASC`,
    [caseId],
  );
  return rows;
}

export async function findRequirementById(requirementId: string): Promise<RequirementRow | null> {
  const { rows } = await getPool().query<RequirementRow>(
    `SELECT ${REQUIREMENT_COLUMNS}
     FROM requirements
     WHERE requirement_id = $1`,
    [requirementId],
  );
  return rows[0] ?? null;
}

export async function insertRequirement(
  client: PoolClient,
  params: {
    requirementId: string; // == entity_id, registered by the caller first
    caseId: string;
    requirementCode: string;
    requirementType: string;
    title: string;
    statement: string;
    rationale: string | null;
    priority: string | null;
    structuredDetail: unknown | null;
  },
): Promise<RequirementRow> {
  const { rows } = await client.query<RequirementRow>(
    `INSERT INTO requirements
       (requirement_id, case_id, requirement_code, requirement_type, title, statement,
        rationale, priority, structured_detail)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
     RETURNING ${REQUIREMENT_COLUMNS}`,
    [
      params.requirementId,
      params.caseId,
      params.requirementCode,
      params.requirementType,
      params.title,
      params.statement,
      params.rationale,
      params.priority,
      params.structuredDetail === null ? null : JSON.stringify(params.structuredDetail),
    ],
  );
  return rows[0]!;
}

export async function updateRequirement(
  client: PoolClient,
  params: {
    requirementId: string;
    title: string;
    statement: string;
    rationale: string | null;
    lifecycleStatus: string;
    priority: string | null;
    structuredDetail: unknown | null;
    newRevisionNo: number;
  },
): Promise<RequirementRow | null> {
  const { rows } = await client.query<RequirementRow>(
    `UPDATE requirements
     SET title = $2, statement = $3, rationale = $4, lifecycle_status = $5,
         priority = $6, structured_detail = $7::jsonb, current_revision_no = $8, updated_at = now()
     WHERE requirement_id = $1
     RETURNING ${REQUIREMENT_COLUMNS}`,
    [
      params.requirementId,
      params.title,
      params.statement,
      params.rationale,
      params.lifecycleStatus,
      params.priority,
      params.structuredDetail === null ? null : JSON.stringify(params.structuredDetail),
      params.newRevisionNo,
    ],
  );
  return rows[0] ?? null;
}

/**
 * Confirms a requirement_code is not already used within the same
 * Case - requirements has UNIQUE(case_id, requirement_code), so this
 * is purely a pre-check to surface a clean VALIDATION_ERROR before
 * attempting the insert; the DB constraint remains the actual source
 * of truth and a race between this check and the insert still
 * surfaces as a 23505 unique_violation, mapped the same way Case
 * Create already does.
 */
export async function requirementCodeExists(caseId: string, requirementCode: string): Promise<boolean> {
  const { rows } = await getPool().query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM requirements WHERE case_id = $1 AND requirement_code = $2
     ) AS exists`,
    [caseId, requirementCode],
  );
  return rows[0]?.exists ?? false;
}
