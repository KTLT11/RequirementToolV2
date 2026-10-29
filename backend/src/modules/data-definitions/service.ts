// Business Data Definition / Attribute — backs the Data / Entity
// Discovery Module's output per Requirement_Framework.md section
// 3.1's Discovery-to-Requirement Mapping ("Data / Entity Module ->
// Data, entity, attribute, state, validation"). Both tables carry a
// FK to entity_identities (confirmed via the repair migration) and
// use the EntityIdentity/EntityRevision pattern on create.
//
// Deliberately scoped to business-level data definitions only, per
// the Framework's own rule (DATA module section D, "Rule: Chỉ khai
// thác dữ liệu ảnh hưởng đến requirement đang xét; không mở rộng
// thành thiết kế database hoặc data model kỹ thuật") - this is NOT a
// technical schema/table designer, just a structured record of
// business entities and attributes a BA discovered.

import { HttpError } from "../../http/errors.js";
import { withTransaction } from "../../db/pool.js";
import { registerEntity, createRevision } from "../entities/repository.js";
import * as repo from "./repository.js";

// data_kind vocabulary taken directly from the Data Dictionary's own
// example values for this column ("ENTITY, VALUE_OBJECT, MESSAGE,
// REPORT_METRIC").
const DATA_KINDS = ["ENTITY", "VALUE_OBJECT", "MESSAGE", "REPORT_METRIC"] as const;
// nullable_policy vocabulary taken directly from the Data
// Dictionary's own example values ("REQUIRED, OPTIONAL,
// CONDITIONAL").
const NULLABLE_POLICIES = ["REQUIRED", "OPTIONAL", "CONDITIONAL"] as const;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: string }).code === "23505"
  );
}

export async function listDataDefinitionsService(caseId: string) {
  if (!isUuid(caseId)) {
    throw new HttpError("VALIDATION_ERROR", "case_id must be a valid UUID");
  }
  const rows = await repo.findDataDefinitionsByCaseId(caseId);
  return { data: rows };
}

export async function getDataDefinitionService(dataDefinitionId: string) {
  if (!isUuid(dataDefinitionId)) {
    throw new HttpError("VALIDATION_ERROR", "data_definition_id must be a valid UUID");
  }
  const definition = await repo.findDataDefinitionById(dataDefinitionId);
  if (!definition) {
    throw new HttpError("NOT_FOUND", `Data definition ${dataDefinitionId} was not found`);
  }
  const attributes = await repo.findAttributesByDataDefinitionId(dataDefinitionId);
  return { data: { ...definition, attributes } };
}

export interface CreateDataDefinitionInput {
  data_code?: unknown;
  entity_name?: unknown;
  business_meaning?: unknown;
  data_kind?: unknown;
}

export async function createDataDefinitionService(
  caseId: string,
  body: CreateDataDefinitionInput,
  callerUserId: string,
) {
  if (!isUuid(caseId)) {
    throw new HttpError("VALIDATION_ERROR", "case_id must be a valid UUID");
  }
  if (!isNonEmptyString(body.data_code)) {
    throw new HttpError("VALIDATION_ERROR", "data_code is required");
  }
  if (!isNonEmptyString(body.entity_name)) {
    throw new HttpError("VALIDATION_ERROR", "entity_name is required");
  }
  if (!isNonEmptyString(body.business_meaning)) {
    throw new HttpError("VALIDATION_ERROR", "business_meaning is required");
  }
  if (
    typeof body.data_kind !== "string" ||
    !DATA_KINDS.includes(body.data_kind as (typeof DATA_KINDS)[number])
  ) {
    throw new HttpError("VALIDATION_ERROR", `data_kind must be one of: ${DATA_KINDS.join(", ")}`);
  }

  try {
    const result = await withTransaction(async (client) => {
      const dataDefinitionId = await registerEntity(client, "BUSINESS_DATA_DEFINITION");

      const created = await repo.insertDataDefinition(client, {
        dataDefinitionId,
        caseId,
        dataCode: body.data_code as string,
        entityName: body.entity_name as string,
        businessMeaning: body.business_meaning as string,
        dataKind: body.data_kind as string,
      });

      await createRevision(client, {
        entityId: dataDefinitionId,
        revisionNo: 1,
        content: { entity_name: created.entity_name, business_meaning: created.business_meaning },
        createdBy: callerUserId,
        changeSummary: "Business data definition created",
      });

      return created;
    });

    return { data: result };
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new HttpError("CONFLICT", "data_code already exists for this case");
    }
    throw err;
  }
}

export interface CreateAttributeInput {
  attribute_code?: unknown;
  attribute_name?: unknown;
  business_type?: unknown;
  nullable_policy?: unknown;
  value_constraints?: unknown;
  business_description?: unknown;
}

export async function createAttributeService(
  dataDefinitionId: string,
  body: CreateAttributeInput,
  callerUserId: string,
) {
  if (!isUuid(dataDefinitionId)) {
    throw new HttpError("VALIDATION_ERROR", "data_definition_id must be a valid UUID");
  }
  const definition = await repo.findDataDefinitionById(dataDefinitionId);
  if (!definition) {
    throw new HttpError("NOT_FOUND", `Data definition ${dataDefinitionId} was not found`);
  }
  if (!isNonEmptyString(body.attribute_code)) {
    throw new HttpError("VALIDATION_ERROR", "attribute_code is required");
  }
  if (!isNonEmptyString(body.attribute_name)) {
    throw new HttpError("VALIDATION_ERROR", "attribute_name is required");
  }
  if (!isNonEmptyString(body.business_type)) {
    throw new HttpError("VALIDATION_ERROR", "business_type is required");
  }
  if (
    typeof body.nullable_policy !== "string" ||
    !NULLABLE_POLICIES.includes(body.nullable_policy as (typeof NULLABLE_POLICIES)[number])
  ) {
    throw new HttpError(
      "VALIDATION_ERROR",
      `nullable_policy must be one of: ${NULLABLE_POLICIES.join(", ")}`,
    );
  }
  if (body.value_constraints !== undefined && typeof body.value_constraints !== "object") {
    throw new HttpError("VALIDATION_ERROR", "value_constraints must be an object when provided");
  }
  const businessDescription =
    typeof body.business_description === "string" ? body.business_description : null;

  try {
    const result = await withTransaction(async (client) => {
      const attributeId = await registerEntity(client, "BUSINESS_DATA_ATTRIBUTE");

      const created = await repo.insertAttribute(client, {
        attributeId,
        dataDefinitionId,
        attributeCode: body.attribute_code as string,
        attributeName: body.attribute_name as string,
        businessType: body.business_type as string,
        nullablePolicy: body.nullable_policy as string,
        valueConstraints: body.value_constraints ?? null,
        businessDescription,
      });

      await createRevision(client, {
        entityId: attributeId,
        revisionNo: 1,
        content: { attribute_name: created.attribute_name, business_type: created.business_type },
        createdBy: callerUserId,
        changeSummary: "Business data attribute created",
      });

      return created;
    });

    return { data: result };
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new HttpError("CONFLICT", "attribute_code already exists for this data definition");
    }
    throw err;
  }
}
