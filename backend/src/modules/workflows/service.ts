// Workflow Scenario / Step / Transition — backs the Process
// Discovery Module's output per Requirement_Framework.md section
// 3.1's Discovery-to-Requirement Mapping ("Process Module -> Actor,
// Trigger, Expected Behavior, Process/State Transition, Alternative
// Flow"). All 3 tables carry a FK to entity_identities (confirmed via
// the repair migration) and use the EntityIdentity/EntityRevision
// pattern on create.
//
// workflow_transitions has a Postgres-enforced composite FK on both
// (workflow_id, source_step_id) and (workflow_id, target_step_id)
// into workflow_steps(workflow_id, step_id) - this guarantees at the
// database level that a transition's endpoints belong to the same
// workflow being referenced, so this service does not need its own
// "same workflow" check beyond what the FK already rejects (a
// mismatched pair surfaces as a 23503 foreign_key_violation, not a
// silent wrong write).

import { HttpError } from "../../http/errors.js";
import { withTransaction } from "../../db/pool.js";
import { registerEntity, createRevision } from "../entities/repository.js";
import * as repo from "./repository.js";

const STEP_TYPES = ["TASK", "DECISION", "START", "END", "EVENT"] as const;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function isForeignKeyViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: string }).code === "23503"
  );
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: string }).code === "23505"
  );
}

export async function listWorkflowsService(caseId: string) {
  if (!isUuid(caseId)) {
    throw new HttpError("VALIDATION_ERROR", "case_id must be a valid UUID");
  }
  const rows = await repo.findWorkflowsByCaseId(caseId);
  return { data: rows };
}

export async function getWorkflowService(workflowId: string) {
  if (!isUuid(workflowId)) {
    throw new HttpError("VALIDATION_ERROR", "workflow_id must be a valid UUID");
  }
  const workflow = await repo.findWorkflowById(workflowId);
  if (!workflow) {
    throw new HttpError("NOT_FOUND", `Workflow ${workflowId} was not found`);
  }
  const steps = await repo.findStepsByWorkflowId(workflowId);
  const transitions = await repo.findTransitionsByWorkflowId(workflowId);
  return { data: { ...workflow, steps, transitions } };
}

export interface CreateWorkflowInput {
  workflow_code?: unknown;
  workflow_name?: unknown;
  trigger_description?: unknown;
}

export async function createWorkflowService(
  caseId: string,
  body: CreateWorkflowInput,
  callerUserId: string,
) {
  if (!isUuid(caseId)) {
    throw new HttpError("VALIDATION_ERROR", "case_id must be a valid UUID");
  }
  if (!isNonEmptyString(body.workflow_code)) {
    throw new HttpError("VALIDATION_ERROR", "workflow_code is required");
  }
  if (!isNonEmptyString(body.workflow_name)) {
    throw new HttpError("VALIDATION_ERROR", "workflow_name is required");
  }
  const triggerDescription =
    typeof body.trigger_description === "string" ? body.trigger_description : null;

  try {
    const result = await withTransaction(async (client) => {
      const workflowId = await registerEntity(client, "WORKFLOW_SCENARIO");

      const created = await repo.insertWorkflow(client, {
        workflowId,
        caseId,
        workflowCode: body.workflow_code as string,
        workflowName: body.workflow_name as string,
        triggerDescription,
      });

      await createRevision(client, {
        entityId: workflowId,
        revisionNo: 1,
        content: { workflow_name: created.workflow_name, scenario_status: created.scenario_status },
        createdBy: callerUserId,
        changeSummary: "Workflow scenario created",
      });

      return created;
    });

    return { data: result };
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new HttpError("CONFLICT", "workflow_code already exists for this case");
    }
    throw err;
  }
}

export interface CreateStepInput {
  step_key?: unknown;
  step_name?: unknown;
  step_type?: unknown;
  step_description?: unknown;
  actor_role_code?: unknown;
  sort_order?: unknown;
}

export async function createStepService(
  workflowId: string,
  body: CreateStepInput,
  callerUserId: string,
) {
  if (!isUuid(workflowId)) {
    throw new HttpError("VALIDATION_ERROR", "workflow_id must be a valid UUID");
  }
  const workflow = await repo.findWorkflowById(workflowId);
  if (!workflow) {
    throw new HttpError("NOT_FOUND", `Workflow ${workflowId} was not found`);
  }
  if (!isNonEmptyString(body.step_key)) {
    throw new HttpError("VALIDATION_ERROR", "step_key is required");
  }
  if (!isNonEmptyString(body.step_name)) {
    throw new HttpError("VALIDATION_ERROR", "step_name is required");
  }
  if (
    typeof body.step_type !== "string" ||
    !STEP_TYPES.includes(body.step_type as (typeof STEP_TYPES)[number])
  ) {
    throw new HttpError("VALIDATION_ERROR", `step_type must be one of: ${STEP_TYPES.join(", ")}`);
  }
  const stepDescription = typeof body.step_description === "string" ? body.step_description : null;
  const actorRoleCode = typeof body.actor_role_code === "string" ? body.actor_role_code : null;
  const sortOrder =
    typeof body.sort_order === "number" && Number.isInteger(body.sort_order)
      ? body.sort_order
      : null;

  try {
    const result = await withTransaction(async (client) => {
      const stepId = await registerEntity(client, "WORKFLOW_STEP");

      const created = await repo.insertStep(client, {
        stepId,
        workflowId,
        stepKey: body.step_key as string,
        stepName: body.step_name as string,
        stepType: body.step_type as string,
        stepDescription,
        actorRoleCode,
        sortOrder,
      });

      await createRevision(client, {
        entityId: stepId,
        revisionNo: 1,
        content: { step_name: created.step_name, step_type: created.step_type },
        createdBy: callerUserId,
        changeSummary: "Workflow step created",
      });

      return created;
    });

    return { data: result };
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new HttpError("CONFLICT", "step_key already exists for this workflow");
    }
    throw err;
  }
}

export interface CreateTransitionInput {
  source_step_id?: unknown;
  target_step_id?: unknown;
  transition_key?: unknown;
  transition_condition?: unknown;
  action_outcome?: unknown;
}

export async function createTransitionService(
  workflowId: string,
  body: CreateTransitionInput,
  callerUserId: string,
) {
  if (!isUuid(workflowId)) {
    throw new HttpError("VALIDATION_ERROR", "workflow_id must be a valid UUID");
  }
  const workflow = await repo.findWorkflowById(workflowId);
  if (!workflow) {
    throw new HttpError("NOT_FOUND", `Workflow ${workflowId} was not found`);
  }
  if (typeof body.source_step_id !== "string" || !isUuid(body.source_step_id)) {
    throw new HttpError("VALIDATION_ERROR", "source_step_id must be a valid UUID");
  }
  if (typeof body.target_step_id !== "string" || !isUuid(body.target_step_id)) {
    throw new HttpError("VALIDATION_ERROR", "target_step_id must be a valid UUID");
  }
  if (!isNonEmptyString(body.transition_key)) {
    throw new HttpError("VALIDATION_ERROR", "transition_key is required");
  }
  const transitionCondition =
    typeof body.transition_condition === "string" ? body.transition_condition : null;
  const actionOutcome = typeof body.action_outcome === "string" ? body.action_outcome : null;

  try {
    const result = await withTransaction(async (client) => {
      const transitionId = await registerEntity(client, "WORKFLOW_TRANSITION");

      const created = await repo.insertTransition(client, {
        transitionId,
        workflowId,
        sourceStepId: body.source_step_id as string,
        targetStepId: body.target_step_id as string,
        transitionKey: body.transition_key as string,
        transitionCondition,
        actionOutcome,
      });

      await createRevision(client, {
        entityId: transitionId,
        revisionNo: 1,
        content: { transition_key: created.transition_key },
        createdBy: callerUserId,
        changeSummary: "Workflow transition created",
      });

      return created;
    });

    return { data: result };
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new HttpError("CONFLICT", "transition_key already exists for this workflow");
    }
    if (isForeignKeyViolation(err)) {
      // Covers both "step does not exist" and "step belongs to a
      // different workflow" - the composite FK
      // (workflow_id, source/target_step_id) rejects either case the
      // same way, and from the caller's side both are "you gave me a
      // step id that isn't valid for this workflow".
      throw new HttpError(
        "VALIDATION_ERROR",
        "source_step_id and target_step_id must both belong to this workflow",
      );
    }
    throw err;
  }
}
