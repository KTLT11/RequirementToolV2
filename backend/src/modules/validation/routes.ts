import { Router, type Request } from "express";
import { authenticate } from "../../auth/authenticate.js";
import { requireRole } from "../../auth/authorize.js";
import {
  createValidationRunService,
  getValidationRunService,
  listValidationRunsService,
  recordHumanReviewedResultService,
} from "./service.js";

// Mounted at /api/cases/:caseId/validation-runs for list/create, and
// /api/validation-runs/:validationRunId for get.
export const caseValidationRunsRouter = Router({ mergeParams: true });
export const validationRunsRouter = Router();

caseValidationRunsRouter.use(authenticate, requireRole("BA"));
validationRunsRouter.use(authenticate, requireRole("BA"));

type CaseParams = Request<{ caseId: string }>;

// GET /api/cases/:caseId/validation-runs
caseValidationRunsRouter.get("/", async (req: CaseParams, res, next) => {
  try {
    const result = await listValidationRunsService(req.params.caseId);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
});

// POST /api/cases/:caseId/validation-runs
caseValidationRunsRouter.post("/", async (req: CaseParams, res, next) => {
  try {
    const result = await createValidationRunService(req.params.caseId, req.user!.userId);
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

// GET /api/validation-runs/:validationRunId
validationRunsRouter.get("/:validationRunId", async (req, res, next) => {
  try {
    const result = await getValidationRunService(req.params.validationRunId!);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
});

// POST /api/validation-runs/:validationRunId/results
validationRunsRouter.post("/:validationRunId/results", async (req, res, next) => {
  try {
    const result = await recordHumanReviewedResultService(
      req.params.validationRunId!,
      req.body,
      req.user!.userId,
    );
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});
