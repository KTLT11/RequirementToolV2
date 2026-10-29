import type { PoolClient } from "pg";
import { getPool } from "../../db/pool.js";

export interface BusinessDataDefinitionRow {
  data_definition_id: string;
  case_id: string;
  data_code: string;
  entity_name: string;
  business_meaning: string;
  data_kind: string;
  status: string;
  current_revision_no: number;
}

export interface BusinessDataAttributeRow {
  attribute_id: string;
  data_definition_id: string;
  attribute_code: string;
  attribute_name: string;
  business_type: string;
  nullable_policy: string;
  value_constraints: unknown;
  business_description: string | null;
  current_revision_no: number;
}

export async function findDataDefinitionsByCaseId(
  caseId: string,
): Promise<BusinessDataDefinitionRow[]> {
  const { rows } = await getPool().query<BusinessDataDefinitionRow>(
    `SELECT data_definition_id, case_id, data_code, entity_name, business_meaning,
            data_kind, status, current_revision_no
     FROM business_data_definitions
     WHERE case_id = $1
     ORDER BY data_code ASC`,
    [caseId],
  );
  return rows;
}

export async function findDataDefinitionById(
  dataDefinitionId: string,
): Promise<BusinessDataDefinitionRow | null> {
  const { rows } = await getPool().query<BusinessDataDefinitionRow>(
    `SELECT data_definition_id, case_id, data_code, entity_name, business_meaning,
            data_kind, status, current_revision_no
     FROM business_data_definitions
     WHERE data_definition_id = $1`,
    [dataDefinitionId],
  );
  return rows[0] ?? null;
}

export async function findAttributesByDataDefinitionId(
  dataDefinitionId: string,
): Promise<BusinessDataAttributeRow[]> {
  const { rows } = await getPool().query<BusinessDataAttributeRow>(
    `SELECT attribute_id, data_definition_id, attribute_code, attribute_name,
            business_type, nullable_policy, value_constraints, business_description,
            current_revision_no
     FROM business_data_attributes
     WHERE data_definition_id = $1
     ORDER BY attribute_code ASC`,
    [dataDefinitionId],
  );
  return rows;
}

export async function insertDataDefinition(
  client: PoolClient,
  params: {
    dataDefinitionId: string; // == entity_id, registered by the caller first
    caseId: string;
    dataCode: string;
    entityName: string;
    businessMeaning: string;
    dataKind: string;
  },
): Promise<BusinessDataDefinitionRow> {
  const { rows } = await client.query<BusinessDataDefinitionRow>(
    `INSERT INTO business_data_definitions
       (data_definition_id, case_id, data_code, entity_name, business_meaning, data_kind)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING data_definition_id, case_id, data_code, entity_name, business_meaning,
               data_kind, status, current_revision_no`,
    [
      params.dataDefinitionId,
      params.caseId,
      params.dataCode,
      params.entityName,
      params.businessMeaning,
      params.dataKind,
    ],
  );
  return rows[0]!;
}

export async function insertAttribute(
  client: PoolClient,
  params: {
    attributeId: string; // == entity_id, registered by the caller first
    dataDefinitionId: string;
    attributeCode: string;
    attributeName: string;
    businessType: string;
    nullablePolicy: string;
    valueConstraints: unknown;
    businessDescription: string | null;
  },
): Promise<BusinessDataAttributeRow> {
  const { rows } = await client.query<BusinessDataAttributeRow>(
    `INSERT INTO business_data_attributes
       (attribute_id, data_definition_id, attribute_code, attribute_name, business_type,
        nullable_policy, value_constraints, business_description)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)
     RETURNING attribute_id, data_definition_id, attribute_code, attribute_name,
               business_type, nullable_policy, value_constraints, business_description,
               current_revision_no`,
    [
      params.attributeId,
      params.dataDefinitionId,
      params.attributeCode,
      params.attributeName,
      params.businessType,
      params.nullablePolicy,
      params.valueConstraints !== null ? JSON.stringify(params.valueConstraints) : null,
      params.businessDescription,
    ],
  );
  return rows[0]!;
}
