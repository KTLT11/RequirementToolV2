import { Router, type Request } from "express";
import { authenticate } from "../../auth/authenticate.js";
import { requireRole } from "../../auth/authorize.js";
import { createDecisionService, listDecisionsService, updateDecisionService } from "./service.js";

// Mounted at /api/cases/:caseId/decisions for list/create, and
// /api/decisions/:decisionId for update.
export const caseDecisionsRouter = Router({ mergeParams: true });
export const decisionsRouter = Router();

caseDecisionsRouter.use(authenticate, requireRole("BA"));
decisionsRouter.use(authenticate, requireRole("BA"));

type CaseParams = Request<{ caseId: string }>;

// GET /api/cases/:caseId/decisions
caseDecisionsRouter.get("/", async (req: CaseParams, res, next) => {
  try {
    const result = await listDecisionsService(req.params.caseId);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
});

// POST /api/cases/:caseId/decisions
caseDecisionsRouter.post("/", async (req: CaseParams, res, next) => {
  try {
    const result = await createDecisionService(req.params.caseId, req.body, req.user!.userId);
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

// PATCH /api/decisions/:decisionId
decisionsRouter.patch("/:decisionId", async (req, res, next) => {
  try {
    const result = await updateDecisionService(req.params.decisionId!, req.body, req.user!.userId);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
});
