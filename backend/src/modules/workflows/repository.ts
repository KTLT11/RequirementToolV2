import type { PoolClient } from "pg";
import { getPool } from "../../db/pool.js";

export interface WorkflowScenarioRow {
  workflow_id: string;
  case_id: string;
  workflow_code: string;
  workflow_name: string;
  trigger_description: string | null;
  scenario_status: string;
  current_revision_no: number;
  created_at: string;
}

export interface WorkflowStepRow {
  step_id: string;
  workflow_id: string;
  step_key: string;
  step_name: string;
  step_type: string;
  step_description: string | null;
  actor_role_code: string | null;
  sort_order: number | null;
  current_revision_no: number;
}

export interface WorkflowTransitionRow {
  transition_id: string;
  workflow_id: string;
  source_step_id: string;
  target_step_id: string;
  transition_key: string;
  transition_condition: string | null;
  action_outcome: string | null;
  current_revision_no: number;
}

export async function findWorkflowsByCaseId(caseId: string): Promise<WorkflowScenarioRow[]> {
  const { rows } = await getPool().query<WorkflowScenarioRow>(
    `SELECT workflow_id, case_id, workflow_code, workflow_name, trigger_description,
            scenario_status, current_revision_no, created_at
     FROM workflow_scenarios
     WHERE case_id = $1
     ORDER BY created_at ASC`,
    [caseId],
  );
  return rows;
}

export async function findWorkflowById(workflowId: string): Promise<WorkflowScenarioRow | null> {
  const { rows } = await getPool().query<WorkflowScenarioRow>(
    `SELECT workflow_id, case_id, workflow_code, workflow_name, trigger_description,
            scenario_status, current_revision_no, created_at
     FROM workflow_scenarios
     WHERE workflow_id = $1`,
    [workflowId],
  );
  return rows[0] ?? null;
}

export async function findStepsByWorkflowId(workflowId: string): Promise<WorkflowStepRow[]> {
  const { rows } = await getPool().query<WorkflowStepRow>(
    `SELECT step_id, workflow_id, step_key, step_name, step_type, step_description,
            actor_role_code, sort_order, current_revision_no
     FROM workflow_steps
     WHERE workflow_id = $1
     ORDER BY sort_order ASC NULLS LAST, step_key ASC`,
    [workflowId],
  );
  return rows;
}

export async function findStepById(stepId: string): Promise<WorkflowStepRow | null> {
  const { rows } = await getPool().query<WorkflowStepRow>(
    `SELECT step_id, workflow_id, step_key, step_name, step_type, step_description,
            actor_role_code, sort_order, current_revision_no
     FROM workflow_steps
     WHERE step_id = $1`,
    [stepId],
  );
  return rows[0] ?? null;
}

export async function findTransitionsByWorkflowId(
  workflowId: string,
): Promise<WorkflowTransitionRow[]> {
  const { rows } = await getPool().query<WorkflowTransitionRow>(
    `SELECT transition_id, workflow_id, source_step_id, target_step_id, transition_key,
            transition_condition, action_outcome, current_revision_no
     FROM workflow_transitions
     WHERE workflow_id = $1`,
    [workflowId],
  );
  return rows;
}

export async function insertWorkflow(
  client: PoolClient,
  params: {
    workflowId: string; // == entity_id, registered by the caller first
    caseId: string;
    workflowCode: string;
    workflowName: string;
    triggerDescription: string | null;
  },
): Promise<WorkflowScenarioRow> {
  const { rows } = await client.query<WorkflowScenarioRow>(
    `INSERT INTO workflow_scenarios
       (workflow_id, case_id, workflow_code, workflow_name, trigger_description)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING workflow_id, case_id, workflow_code, workflow_name, trigger_description,
               scenario_status, current_revision_no, created_at`,
    [params.workflowId, params.caseId, params.workflowCode, params.workflowName, params.triggerDescription],
  );
  return rows[0]!;
}

export async function insertStep(
  client: PoolClient,
  params: {
    stepId: string; // == entity_id, registered by the caller first
    workflowId: string;
    stepKey: string;
    stepName: string;
    stepType: string;
    stepDescription: string | null;
    actorRoleCode: string | null;
    sortOrder: number | null;
  },
): Promise<WorkflowStepRow> {
  const { rows } = await client.query<WorkflowStepRow>(
    `INSERT INTO workflow_steps
       (step_id, workflow_id, step_key, step_name, step_type, step_description,
        actor_role_code, sort_order)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING step_id, workflow_id, step_key, step_name, step_type, step_description,
               actor_role_code, sort_order, current_revision_no`,
    [
      params.stepId,
      params.workflowId,
      params.stepKey,
      params.stepName,
      params.stepType,
      params.stepDescription,
      params.actorRoleCode,
      params.sortOrder,
    ],
  );
  return rows[0]!;
}

export async function insertTransition(
  client: PoolClient,
  params: {
    transitionId: string; // == entity_id, registered by the caller first
    workflowId: string;
    sourceStepId: string;
    targetStepId: string;
    transitionKey: string;
    transitionCondition: string | null;
    actionOutcome: string | null;
  },
): Promise<WorkflowTransitionRow> {
  const { rows } = await client.query<WorkflowTransitionRow>(
    `INSERT INTO workflow_transitions
       (transition_id, workflow_id, source_step_id, target_step_id, transition_key,
        transition_condition, action_outcome)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING transition_id, workflow_id, source_step_id, target_step_id, transition_key,
               transition_condition, action_outcome, current_revision_no`,
    [
      params.transitionId,
      params.workflowId,
      params.sourceStepId,
      params.targetStepId,
      params.transitionKey,
      params.transitionCondition,
      params.actionOutcome,
    ],
  );
  return rows[0]!;
}
