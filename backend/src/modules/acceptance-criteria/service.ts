// P3-FR-019 — Acceptance Criteria. Owned by exactly one Requirement
// (UNIQUE(requirement_id, ac_code), acceptance_criteria.ac_id carries
// a FK to entity_identities per migration 007's verification).

import { HttpError } from "../../http/errors.js";
import { withTransaction } from "../../db/pool.js";
import { registerEntity, createRevision } from "../entities/repository.js";
import { findRequirementById } from "../requirements/repository.js";
import * as repo from "./repository.js";

const AC_STATUSES = ["DRAFT", "READY"] as const;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

export async function listAcService(requirementId: string) {
  if (!isUuid(requirementId)) {
    throw new HttpError("VALIDATION_ERROR", "requirement_id must be a valid UUID");
  }
  const rows = await repo.findAcByRequirementId(requirementId);
  return { data: rows };
}

export interface CreateAcInput {
  ac_code?: unknown;
  condition_text?: unknown;
  expected_outcome?: unknown;
  verification_method?: unknown;
}

export async function createAcService(
  requirementId: string,
  body: CreateAcInput,
  callerUserId: string,
) {
  if (!isUuid(requirementId)) {
    throw new HttpError("VALIDATION_ERROR", "requirement_id must be a valid UUID");
  }
  const requirement = await findRequirementById(requirementId);
  if (!requirement) {
    throw new HttpError("NOT_FOUND", `Requirement ${requirementId} was not found`);
  }
  if (!isNonEmptyString(body.ac_code)) {
    throw new HttpError("VALIDATION_ERROR", "ac_code is required");
  }
  if (!isNonEmptyString(body.condition_text)) {
    throw new HttpError("VALIDATION_ERROR", "condition_text is required");
  }
  if (!isNonEmptyString(body.expected_outcome)) {
    throw new HttpError("VALIDATION_ERROR", "expected_outcome is required");
  }
  const verificationMethod =
    typeof body.verification_method === "string" ? body.verification_method : null;

  try {
    const result = await withTransaction(async (client) => {
      const acId = await registerEntity(client, "ACCEPTANCE_CRITERION");

      const created = await repo.insertAc(client, {
        acId,
        requirementId,
        acCode: body.ac_code as string,
        conditionText: body.condition_text as string,
        expectedOutcome: body.expected_outcome as string,
        verificationMethod,
      });

      await createRevision(client, {
        entityId: acId,
        revisionNo: 1,
        content: {
          condition_text: created.condition_text,
          expected_outcome: created.expected_outcome,
          status: created.status,
        },
        createdBy: callerUserId,
        changeSummary: "Acceptance criterion created",
      });

      return created;
    });

    return { data: result };
  } catch (err) {
    if (
      typeof err === "object" &&
      err !== null &&
      "code" in err &&
      (err as { code?: string }).code === "23505"
    ) {
      throw new HttpError("CONFLICT", "ac_code already exists for this requirement");
    }
    throw err;
  }
}

export interface UpdateAcInput {
  condition_text?: unknown;
  expected_outcome?: unknown;
  verification_method?: unknown;
  status?: unknown;
}

export async function updateAcService(
  acId: string,
  body: UpdateAcInput,
  callerUserId: string,
) {
  if (!isUuid(acId)) {
    throw new HttpError("VALIDATION_ERROR", "ac_id must be a valid UUID");
  }
  if (!isNonEmptyString(body.condition_text)) {
    throw new HttpError("VALIDATION_ERROR", "condition_text is required");
  }
  if (!isNonEmptyString(body.expected_outcome)) {
    throw new HttpError("VALIDATION_ERROR", "expected_outcome is required");
  }
  if (
    typeof body.status !== "string" ||
    !AC_STATUSES.includes(body.status as (typeof AC_STATUSES)[number])
  ) {
    throw new HttpError("VALIDATION_ERROR", `status must be one of: ${AC_STATUSES.join(", ")}`);
  }
  const verificationMethod =
    typeof body.verification_method === "string" ? body.verification_method : null;

  const existing = await repo.findAcById(acId);
  if (!existing) {
    throw new HttpError("NOT_FOUND", `Acceptance criterion ${acId} was not found`);
  }

  const newRevisionNo = existing.current_revision_no + 1;

  const result = await withTransaction(async (client) => {
    const updated = await repo.updateAc(client, {
      acId,
      conditionText: body.condition_text as string,
      expectedOutcome: body.expected_outcome as string,
      verificationMethod,
      status: body.status as string,
      newRevisionNo,
    });

    if (!updated) {
      throw new HttpError("NOT_FOUND", `Acceptance criterion ${acId} was not found`);
    }

    await createRevision(client, {
      entityId: acId,
      revisionNo: newRevisionNo,
      content: {
        condition_text: updated.condition_text,
        expected_outcome: updated.expected_outcome,
        status: updated.status,
      },
      createdBy: callerUserId,
      changeSummary: "Acceptance criterion updated",
    });

    return updated;
  });

  return { data: result };
}
