// Pure SQL, no business rule decisions here - repository functions
// only know how to read/write rows given already-validated inputs.
// service.ts decides *whether* to call these and in what order;
// routes.ts decides *what counts as a valid request*.

import type { PoolClient } from "pg";
import { getPool } from "../../db/pool.js";

export interface CaseRow {
  case_id: string;
  case_code: string;
  case_name: string;
  status: string;
  primary_owner_user_id: string;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
}

export interface IncomingRequestRow {
  request_id: string;
  request_code: string;
  request_text: string;
  source_type: string;
  received_at: string;
  source_reference: string | null;
  created_at: string;
}

export interface CaseRequestAssociationRow {
  case_request_id: string;
  case_id: string;
  request_id: string;
  relation_role: string;
  linked_at: string;
  linked_by: string;
  unlinked_at: string | null;
}

export interface RequirementSummaryRow {
  requirement_id: string;
  requirement_code: string;
  requirement_type: string;
  title: string;
  lifecycle_status: string;
  priority: string | null;
  created_at: string;
  updated_at: string;
}

export interface ListCasesParams {
  page: number;
  pageSize: number;
  search: string;
  statusFilter: string;
}

export async function listCases(
  params: ListCasesParams,
): Promise<{ rows: CaseRow[]; totalCount: number }> {
  const { page, pageSize, search, statusFilter } = params;
  const offset = (page - 1) * pageSize;

  const conditions: string[] = [];
  const values: unknown[] = [];

  if (statusFilter) {
    values.push(statusFilter);
    conditions.push(`status = $${values.length}`);
  }
  if (search) {
    values.push(`%${search}%`);
    const idx = values.length;
    conditions.push(`(case_code ILIKE $${idx} OR case_name ILIKE $${idx})`);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const countResult = await getPool().query<{ count: string }>(
    `SELECT count(*) FROM cases ${whereClause}`,
    values,
  );
  const totalCount = Number(countResult.rows[0]?.count ?? 0);

  values.push(pageSize, offset);
  const dataResult = await getPool().query<CaseRow>(
    `SELECT case_id, case_code, case_name, status, primary_owner_user_id,
            created_at, updated_at, closed_at
     FROM cases
     ${whereClause}
     ORDER BY created_at DESC
     LIMIT $${values.length - 1} OFFSET $${values.length}`,
    values,
  );

  return { rows: dataResult.rows, totalCount };
}

export async function findCaseById(caseId: string): Promise<CaseRow | null> {
  const { rows } = await getPool().query<CaseRow>(
    `SELECT case_id, case_code, case_name, status, primary_owner_user_id,
            created_at, updated_at, closed_at
     FROM cases WHERE case_id = $1`,
    [caseId],
  );
  return rows[0] ?? null;
}

export async function findActiveLinkedRequestIds(caseId: string): Promise<string[]> {
  const { rows } = await getPool().query<{ request_id: string }>(
    `SELECT request_id FROM case_request_associations
     WHERE case_id = $1 AND unlinked_at IS NULL`,
    [caseId],
  );
  return rows.map((r) => r.request_id);
}

export async function findIncomingRequestsByIds(
  requestIds: string[],
): Promise<IncomingRequestRow[]> {
  if (requestIds.length === 0) return [];
  const { rows } = await getPool().query<IncomingRequestRow>(
    `SELECT request_id, request_code, request_text, source_type,
            received_at, source_reference, created_at
     FROM incoming_requests WHERE request_id = ANY($1)`,
    [requestIds],
  );
  return rows;
}

export async function findRequirementSummariesByCaseId(
  caseId: string,
): Promise<RequirementSummaryRow[]> {
  const { rows } = await getPool().query<RequirementSummaryRow>(
    `SELECT requirement_id, requirement_code, requirement_type, title,
            lifecycle_status, priority, created_at, updated_at
     FROM requirements
     WHERE case_id = $1
     ORDER BY created_at DESC`,
    [caseId],
  );
  return rows;
}

// --- Write operations: always take a PoolClient from an open
// transaction (service.ts's withTransaction), never the shared pool
// directly - so every INSERT in a single business operation commits
// or rolls back together.

export async function insertCase(
  client: PoolClient,
  params: { caseCode: string; caseName: string; ownerUserId: string },
): Promise<CaseRow> {
  const { rows } = await client.query<CaseRow>(
    `INSERT INTO cases (case_code, case_name, status, primary_owner_user_id)
     VALUES ($1, $2, 'IN_PROGRESS', $3)
     RETURNING case_id, case_code, case_name, status, primary_owner_user_id,
               created_at, updated_at, closed_at`,
    [params.caseCode, params.caseName, params.ownerUserId],
  );
  // INSERT ... RETURNING always returns exactly one row on success,
  // or the query throws (constraint violation) - there is no "zero
  // rows, no error" case to guard against here.
  return rows[0]!;
}

export async function insertIncomingRequest(
  client: PoolClient,
  params: {
    requestCode: string;
    requestText: string;
    sourceType: string;
    receivedAt: string;
    recordedBy: string;
    sourceReference: string | null;
  },
): Promise<IncomingRequestRow> {
  const { rows } = await client.query<IncomingRequestRow>(
    `INSERT INTO incoming_requests
       (request_code, request_text, source_type, received_at, recorded_by, source_reference)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING request_id, request_code, request_text, source_type,
               received_at, source_reference, created_at`,
    [
      params.requestCode,
      params.requestText,
      params.sourceType,
      params.receivedAt,
      params.recordedBy,
      params.sourceReference,
    ],
  );
  return rows[0]!;
}

export async function insertCaseRequestAssociation(
  client: PoolClient,
  params: { caseId: string; requestId: string; linkedBy: string },
): Promise<CaseRequestAssociationRow> {
  const { rows } = await client.query<CaseRequestAssociationRow>(
    `INSERT INTO case_request_associations (case_id, request_id, relation_role, linked_by)
     VALUES ($1, $2, 'SOURCE', $3)
     RETURNING case_request_id, case_id, request_id, relation_role, linked_at, linked_by, unlinked_at`,
    [params.caseId, params.requestId, params.linkedBy],
  );
  return rows[0]!;
}

export async function insertAuditEvent(
  client: PoolClient,
  params: {
    caseId: string;
    eventType: string;
    actorUserId: string;
    eventPayload: Record<string, unknown>;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO audit_events (case_id, event_type, actor_user_id, event_payload, occurred_at)
     VALUES ($1, $2, $3, $4, now())`,
    [params.caseId, params.eventType, params.actorUserId, params.eventPayload],
  );
}

export async function updateCaseName(
  client: PoolClient,
  params: { caseId: string; caseName: string },
): Promise<CaseRow | null> {
  const { rows } = await client.query<CaseRow>(
    `UPDATE cases
     SET case_name = $2, updated_at = now()
     WHERE case_id = $1
     RETURNING case_id, case_code, case_name, status, primary_owner_user_id,
               created_at, updated_at, closed_at`,
    [params.caseId, params.caseName],
  );
  return rows[0] ?? null;
}
