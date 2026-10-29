import type { PoolClient } from "pg";
import { getPool } from "../../db/pool.js";

export interface BusinessRuleRow {
  rule_id: string;
  case_id: string;
  rule_code: string;
  rule_statement: string;
  rule_type: string;
  status: string;
  // B1.3 Structured Semantic Data - opaque to this layer. Service.ts
  // is the only place that knows/validates its shape
  // ({ profile_version, kind, ...fields-by-kind }); repository just
  // stores and returns whatever JSON value it was given.
  rule_detail: unknown | null;
  current_revision_no: number;
  created_at: string;
}

const BUSINESS_RULE_COLUMNS = `rule_id, case_id, rule_code, rule_statement, rule_type, status,
            rule_detail, current_revision_no, created_at`;

export async function findRulesByCaseId(caseId: string): Promise<BusinessRuleRow[]> {
  const { rows } = await getPool().query<BusinessRuleRow>(
    `SELECT ${BUSINESS_RULE_COLUMNS}
     FROM business_rules
     WHERE case_id = $1
     ORDER BY created_at ASC`,
    [caseId],
  );
  return rows;
}

export async function findRuleById(ruleId: string): Promise<BusinessRuleRow | null> {
  const { rows } = await getPool().query<BusinessRuleRow>(
    `SELECT ${BUSINESS_RULE_COLUMNS}
     FROM business_rules
     WHERE rule_id = $1`,
    [ruleId],
  );
  return rows[0] ?? null;
}

export async function insertRule(
  client: PoolClient,
  params: {
    ruleId: string; // == entity_id, registered by the caller first
    caseId: string;
    ruleCode: string;
    ruleStatement: string;
    ruleType: string;
    ruleDetail: unknown | null;
  },
): Promise<BusinessRuleRow> {
  const { rows } = await client.query<BusinessRuleRow>(
    `INSERT INTO business_rules (rule_id, case_id, rule_code, rule_statement, rule_type, rule_detail)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)
     RETURNING ${BUSINESS_RULE_COLUMNS}`,
    [
      params.ruleId,
      params.caseId,
      params.ruleCode,
      params.ruleStatement,
      params.ruleType,
      params.ruleDetail === null ? null : JSON.stringify(params.ruleDetail),
    ],
  );
  return rows[0]!;
}

export async function updateRule(
  client: PoolClient,
  params: {
    ruleId: string;
    ruleStatement: string;
    status: string;
    ruleDetail: unknown | null;
    newRevisionNo: number;
  },
): Promise<BusinessRuleRow | null> {
  const { rows } = await client.query<BusinessRuleRow>(
    `UPDATE business_rules
     SET rule_statement = $2, status = $3, rule_detail = $4::jsonb, current_revision_no = $5
     WHERE rule_id = $1
     RETURNING ${BUSINESS_RULE_COLUMNS}`,
    [
      params.ruleId,
      params.ruleStatement,
      params.status,
      params.ruleDetail === null ? null : JSON.stringify(params.ruleDetail),
      params.newRevisionNo,
    ],
  );
  return rows[0] ?? null;
}
