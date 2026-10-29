import type { PoolClient } from "pg";
import { getPool } from "../../db/pool.js";

export interface BusinessContextRow {
  context_id: string;
  case_id: string;
  context_type: string;
  content: string;
  knowledge_status: string;
  source_entity_id: string | null;
  current_revision_no: number;
  created_at: string;
  updated_at: string;
}

export async function findContextsByCaseId(caseId: string): Promise<BusinessContextRow[]> {
  const { rows } = await getPool().query<BusinessContextRow>(
    `SELECT context_id, case_id, context_type, content, knowledge_status,
            source_entity_id, current_revision_no, created_at, updated_at
     FROM business_contexts
     WHERE case_id = $1
     ORDER BY created_at ASC`,
    [caseId],
  );
  return rows;
}

export async function findContextById(contextId: string): Promise<BusinessContextRow | null> {
  const { rows } = await getPool().query<BusinessContextRow>(
    `SELECT context_id, case_id, context_type, content, knowledge_status,
            source_entity_id, current_revision_no, created_at, updated_at
     FROM business_contexts
     WHERE context_id = $1`,
    [contextId],
  );
  return rows[0] ?? null;
}

export async function insertContext(
  client: PoolClient,
  params: {
    contextId: string; // == entity_id, registered by the caller first
    caseId: string;
    contextType: string;
    content: string;
    knowledgeStatus: string;
    sourceEntityId: string | null;
  },
): Promise<BusinessContextRow> {
  const { rows } = await client.query<BusinessContextRow>(
    `INSERT INTO business_contexts
       (context_id, case_id, context_type, content, knowledge_status, source_entity_id)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING context_id, case_id, context_type, content, knowledge_status,
               source_entity_id, current_revision_no, created_at, updated_at`,
    [
      params.contextId,
      params.caseId,
      params.contextType,
      params.content,
      params.knowledgeStatus,
      params.sourceEntityId,
    ],
  );
  return rows[0]!;
}

export async function updateContext(
  client: PoolClient,
  params: {
    contextId: string;
    content: string;
    knowledgeStatus: string;
    sourceEntityId: string | null;
    newRevisionNo: number;
  },
): Promise<BusinessContextRow | null> {
  const { rows } = await client.query<BusinessContextRow>(
    `UPDATE business_contexts
     SET content = $2, knowledge_status = $3, source_entity_id = $4,
         current_revision_no = $5, updated_at = now()
     WHERE context_id = $1
     RETURNING context_id, case_id, context_type, content, knowledge_status,
               source_entity_id, current_revision_no, created_at, updated_at`,
    [params.contextId, params.content, params.knowledgeStatus, params.sourceEntityId, params.newRevisionNo],
  );
  return rows[0] ?? null;
}
