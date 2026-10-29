// P3-FR-008 — Module Application. Applies a Discovery Module (one of
// the 7 registered in the Rule Registry: PROC/INT/RULE/DATA/PERM/EXC/
// NFR) to a Case. A Case can have multiple modules applied at once
// (AC-02: "BA can select multiple modules and switch between them
// without losing saved data") and a module not applicable is simply
// never applied, not force-completed (AC-03).
//
// No EntityIdentity/EntityRevision here — module_applications has no
// FK to entity_identities in the applied schema (verified directly
// against the migration, not the Data Dictionary workbook). History
// is just the started_at/completed_at timestamps plus
// application_status transitions.

import { HttpError } from "../../http/errors.js";
import { withTransaction } from "../../db/pool.js";
import { isActiveModuleDefinition } from "../definitions/repository.js";
import * as repo from "./repository.js";

const APPLICATION_STATUSES = ["ACTIVE", "COMPLETED", "REMOVED"] as const;

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

export async function listModuleApplicationsService(caseId: string) {
  if (!isUuid(caseId)) {
    throw new HttpError("VALIDATION_ERROR", "case_id must be a valid UUID");
  }
  const rows = await repo.findModuleApplicationsByCaseId(caseId);
  return { data: rows };
}

export interface ApplyModuleInput {
  module_definition_version_id?: unknown;
  reason?: unknown;
}

export async function applyModuleService(
  caseId: string,
  body: ApplyModuleInput,
) {
  if (!isUuid(caseId)) {
    throw new HttpError("VALIDATION_ERROR", "case_id must be a valid UUID");
  }
  if (
    typeof body.module_definition_version_id !== "string" ||
    !isUuid(body.module_definition_version_id)
  ) {
    throw new HttpError(
      "VALIDATION_ERROR",
      "module_definition_version_id must be a valid UUID",
    );
  }

  const isActive = await isActiveModuleDefinition(body.module_definition_version_id);
  if (!isActive) {
    throw new HttpError(
      "VALIDATION_ERROR",
      "module_definition_version_id does not refer to an active MODULE definition",
    );
  }

  const reason = typeof body.reason === "string" ? body.reason : null;

  const result = await withTransaction((client) =>
    repo.insertModuleApplication(client, {
      caseId,
      moduleDefinitionVersionId: body.module_definition_version_id as string,
      reason,
    }),
  );

  return { data: result };
}

export interface UpdateModuleApplicationInput {
  application_status?: unknown;
}

export async function updateModuleApplicationService(
  moduleApplicationId: string,
  body: UpdateModuleApplicationInput,
) {
  if (!isUuid(moduleApplicationId)) {
    throw new HttpError("VALIDATION_ERROR", "module_application_id must be a valid UUID");
  }
  if (
    typeof body.application_status !== "string" ||
    !APPLICATION_STATUSES.includes(
      body.application_status as (typeof APPLICATION_STATUSES)[number],
    )
  ) {
    throw new HttpError(
      "VALIDATION_ERROR",
      `application_status must be one of: ${APPLICATION_STATUSES.join(", ")}`,
    );
  }

  const existing = await repo.findModuleApplicationById(moduleApplicationId);
  if (!existing) {
    throw new HttpError("NOT_FOUND", `Module application ${moduleApplicationId} was not found`);
  }

  // completed_at is set exactly when transitioning to COMPLETED or
  // REMOVED, matching chk_module_completion_time (completed_at IS
  // NULL OR completed_at >= started_at) - ACTIVE never carries a
  // completed_at.
  const completedAt =
    body.application_status === "ACTIVE" ? null : new Date().toISOString();

  const result = await withTransaction((client) =>
    repo.updateModuleApplicationStatus(client, {
      moduleApplicationId,
      applicationStatus: body.application_status as string,
      completedAt,
    }),
  );

  if (!result) {
    throw new HttpError("NOT_FOUND", `Module application ${moduleApplicationId} was not found`);
  }

  return { data: result };
}
