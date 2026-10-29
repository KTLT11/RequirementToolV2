import type { PoolClient } from "pg";
import { getPool } from "../../db/pool.js";

export interface InformationGapRow {
  gap_id: string;
  case_id: string;
  condition_type: string;
  required_information_key: string | null;
  check_result_id: string | null;
  affected_entity_id: string | null;
  gap_summary: string;
  gap_status: string;
  created_at: string;
  resolved_at: string | null;
}

export async function findGapsByCaseId(
  caseId: string,
  statusFilter: string | null,
): Promise<InformationGapRow[]> {
  const values: unknown[] = [caseId];
  let whereClause = "WHERE case_id = $1";
  if (statusFilter) {
    values.push(statusFilter);
    whereClause += ` AND gap_status = $${values.length}`;
  }

  const { rows } = await getPool().query<InformationGapRow>(
    `SELECT gap_id, case_id, condition_type, required_information_key,
            check_result_id, affected_entity_id, gap_summary, gap_status,
            created_at, resolved_at
     FROM information_gaps
     ${whereClause}
     ORDER BY created_at ASC`,
    values,
  );
  return rows;
}

export async function findGapById(gapId: string): Promise<InformationGapRow | null> {
  const { rows } = await getPool().query<InformationGapRow>(
    `SELECT gap_id, case_id, condition_type, required_information_key,
            check_result_id, affected_entity_id, gap_summary, gap_status,
            created_at, resolved_at
     FROM information_gaps
     WHERE gap_id = $1`,
    [gapId],
  );
  return rows[0] ?? null;
}

export async function insertGap(
  client: PoolClient,
  params: {
    gapId: string; // == entity_id, registered by the caller first
    caseId: string;
    conditionType: string;
    requiredInformationKey: string | null;
    affectedEntityId: string | null;
    gapSummary: string;
  },
): Promise<InformationGapRow> {
  const { rows } = await client.query<InformationGapRow>(
    `INSERT INTO information_gaps
       (gap_id, case_id, condition_type, required_information_key, affected_entity_id, gap_summary)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING gap_id, case_id, condition_type, required_information_key,
               check_result_id, affected_entity_id, gap_summary, gap_status,
               created_at, resolved_at`,
    [
      params.gapId,
      params.caseId,
      params.conditionType,
      params.requiredInformationKey,
      params.affectedEntityId,
      params.gapSummary,
    ],
  );
  return rows[0]!;
}

export async function updateGapStatus(
  client: PoolClient,
  params: { gapId: string; gapStatus: string; resolvedAt: string | null },
): Promise<InformationGapRow | null> {
  const { rows } = await client.query<InformationGapRow>(
    `UPDATE information_gaps
     SET gap_status = $2, resolved_at = $3
     WHERE gap_id = $1
     RETURNING gap_id, case_id, condition_type, required_information_key,
               check_result_id, affected_entity_id, gap_summary, gap_status,
               created_at, resolved_at`,
    [params.gapId, params.gapStatus, params.resolvedAt],
  );
  return rows[0] ?? null;
}
