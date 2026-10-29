import { Router, type Request } from "express";
import { authenticate } from "../../auth/authenticate.js";
import { requireRole } from "../../auth/authorize.js";
import { getScopeService, putScopeService } from "./service.js";

// Mounted at /api/cases/:caseId/scope
export const caseScopeRouter = Router({ mergeParams: true });

caseScopeRouter.use(authenticate, requireRole("BA"));

type CaseParams = Request<{ caseId: string }>;

// GET /api/cases/:caseId/scope
caseScopeRouter.get("/", async (req: CaseParams, res, next) => {
  try {
    const result = await getScopeService(req.params.caseId);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
});

// PUT /api/cases/:caseId/scope
caseScopeRouter.put("/", async (req: CaseParams, res, next) => {
  try {
    const result = await putScopeService(req.params.caseId, req.body, req.user!.userId);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
});
