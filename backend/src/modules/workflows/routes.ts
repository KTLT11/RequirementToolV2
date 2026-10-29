import { Router, type Request } from "express";
import { authenticate } from "../../auth/authenticate.js";
import { requireRole } from "../../auth/authorize.js";
import {
  createStepService,
  createTransitionService,
  createWorkflowService,
  getWorkflowService,
  listWorkflowsService,
} from "./service.js";

// Mounted at /api/cases/:caseId/workflows for list/create, and
// /api/workflows/:workflowId[/steps|/transitions] for get + children.
export const caseWorkflowsRouter = Router({ mergeParams: true });
export const workflowsRouter = Router();

caseWorkflowsRouter.use(authenticate, requireRole("BA"));
workflowsRouter.use(authenticate, requireRole("BA"));

type CaseParams = Request<{ caseId: string }>;
type WorkflowParams = Request<{ workflowId: string }>;

// GET /api/cases/:caseId/workflows
caseWorkflowsRouter.get("/", async (req: CaseParams, res, next) => {
  try {
    const result = await listWorkflowsService(req.params.caseId);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
});

// POST /api/cases/:caseId/workflows
caseWorkflowsRouter.post("/", async (req: CaseParams, res, next) => {
  try {
    const result = await createWorkflowService(req.params.caseId, req.body, req.user!.userId);
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

// GET /api/workflows/:workflowId (includes steps + transitions)
workflowsRouter.get("/:workflowId", async (req: WorkflowParams, res, next) => {
  try {
    const result = await getWorkflowService(req.params.workflowId);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
});

// POST /api/workflows/:workflowId/steps
workflowsRouter.post("/:workflowId/steps", async (req: WorkflowParams, res, next) => {
  try {
    const result = await createStepService(req.params.workflowId, req.body, req.user!.userId);
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

// POST /api/workflows/:workflowId/transitions
workflowsRouter.post("/:workflowId/transitions", async (req: WorkflowParams, res, next) => {
  try {
    const result = await createTransitionService(req.params.workflowId, req.body, req.user!.userId);
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});
