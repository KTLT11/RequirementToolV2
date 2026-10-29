import type { PoolClient } from "pg";
import { getPool } from "../../db/pool.js";

export interface ModuleApplicationRow {
  module_application_id: string;
  case_id: string;
  module_definition_version_id: string;
  application_status: string;
  reason: string | null;
  started_at: string;
  completed_at: string | null;
}

export async function findModuleApplicationsByCaseId(
  caseId: string,
): Promise<ModuleApplicationRow[]> {
  const { rows } = await getPool().query<ModuleApplicationRow>(
    `SELECT module_application_id, case_id, module_definition_version_id,
            application_status, reason, started_at, completed_at
     FROM module_applications
     WHERE case_id = $1
     ORDER BY started_at ASC`,
    [caseId],
  );
  return rows;
}

export async function findModuleApplicationById(
  moduleApplicationId: string,
): Promise<ModuleApplicationRow | null> {
  const { rows } = await getPool().query<ModuleApplicationRow>(
    `SELECT module_application_id, case_id, module_definition_version_id,
            application_status, reason, started_at, completed_at
     FROM module_applications
     WHERE module_application_id = $1`,
    [moduleApplicationId],
  );
  return rows[0] ?? null;
}

export async function insertModuleApplication(
  client: PoolClient,
  params: { caseId: string; moduleDefinitionVersionId: string; reason: string | null },
): Promise<ModuleApplicationRow> {
  const { rows } = await client.query<ModuleApplicationRow>(
    `INSERT INTO module_applications (case_id, module_definition_version_id, reason)
     VALUES ($1, $2, $3)
     RETURNING module_application_id, case_id, module_definition_version_id,
               application_status, reason, started_at, completed_at`,
    [params.caseId, params.moduleDefinitionVersionId, params.reason],
  );
  return rows[0]!;
}

export async function updateModuleApplicationStatus(
  client: PoolClient,
  params: { moduleApplicationId: string; applicationStatus: string; completedAt: string | null },
): Promise<ModuleApplicationRow | null> {
  const { rows } = await client.query<ModuleApplicationRow>(
    `UPDATE module_applications
     SET application_status = $2, completed_at = $3
     WHERE module_application_id = $1
     RETURNING module_application_id, case_id, module_definition_version_id,
               application_status, reason, started_at, completed_at`,
    [params.moduleApplicationId, params.applicationStatus, params.completedAt],
  );
  return rows[0] ?? null;
}
