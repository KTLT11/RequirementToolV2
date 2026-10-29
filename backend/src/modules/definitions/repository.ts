// Read-only access to the Rule Registry (definition_versions). No
// admin API here, per FR-023 AC-04 / FR-023B AC-04 ("no admin UI
// required in MVP") — this module only answers "does this id refer
// to a real, active definition of the expected type", used by
// Module Application (definition_type = MODULE) and Discovery
// Answer (definition_type = QUESTION) to validate the otherwise
// FK-less UUID columns they're given.

import { getPool } from "../../db/pool.js";

export interface DefinitionVersionRow {
  definition_version_id: string;
  definition_id: string;
  definition_type: string;
  definition_code: string;
  version_no: number;
  applicability: unknown;
  definition_body: unknown;
  status: string;
  published_at: string | null;
  created_at: string;
}

async function isActiveDefinitionOfType(
  definitionVersionId: string,
  definitionType: string,
): Promise<boolean> {
  const { rows } = await getPool().query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM definition_versions
       WHERE definition_version_id = $1
         AND definition_type = $2
         AND status = 'ACTIVE'
     ) AS exists`,
    [definitionVersionId, definitionType],
  );
  return rows[0]?.exists ?? false;
}

export function isActiveModuleDefinition(definitionVersionId: string): Promise<boolean> {
  return isActiveDefinitionOfType(definitionVersionId, "MODULE");
}

export function isActiveQuestionDefinition(definitionVersionId: string): Promise<boolean> {
  return isActiveDefinitionOfType(definitionVersionId, "QUESTION");
}

export async function listDefinitionsByType(
  definitionType: string,
): Promise<DefinitionVersionRow[]> {
  const { rows } = await getPool().query<DefinitionVersionRow>(
    `SELECT definition_version_id, definition_id, definition_type, definition_code,
            version_no, applicability, definition_body, status, published_at, created_at
     FROM definition_versions
     WHERE definition_type = $1
     ORDER BY definition_code ASC`,
    [definitionType],
  );
  return rows;
}

/**
 * Resolves a single ACTIVE definition_version_id by (definition_type,
 * definition_code) - used by P2-D's Validation Run service to look up
 * the 3 seeded CHECK_RULE definitions (migration 013) by their fixed
 * codes, and to resolve a policy_version_id for validation_runs
 * (this MVP slice treats the fixed set of 3 seeded CHECK_RULEs AS the
 * policy - there is no separate POLICY definition_type in the
 * approved schema/plan, so REQ_HAS_AC's own definition_version_id
 * doubles as validation_runs.policy_version_id; inventing a distinct
 * POLICY definition_type was explicitly out of scope).
 */
export async function findActiveDefinitionVersionIdByCode(
  definitionType: string,
  definitionCode: string,
): Promise<string | null> {
  const { rows } = await getPool().query<{ definition_version_id: string }>(
    `SELECT definition_version_id FROM definition_versions
     WHERE definition_type = $1 AND definition_code = $2 AND status = 'ACTIVE'`,
    [definitionType, definitionCode],
  );
  return rows[0]?.definition_version_id ?? null;
}
