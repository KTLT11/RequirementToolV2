import { Router, type Request } from "express";
import { authenticate } from "../../auth/authenticate.js";
import { requireRole } from "../../auth/authorize.js";
import { applyModuleService, listModuleApplicationsService, updateModuleApplicationService } from "./service.js";

// Mounted at /api/cases/:caseId/modules for list/apply, and
// /api/module-applications/:moduleApplicationId for status updates.
export const caseModulesRouter = Router({ mergeParams: true });
export const moduleApplicationsRouter = Router();

caseModulesRouter.use(authenticate, requireRole("BA"));
moduleApplicationsRouter.use(authenticate, requireRole("BA"));

type CaseParams = Request<{ caseId: string }>;

// GET /api/cases/:caseId/modules
caseModulesRouter.get("/", async (req: CaseParams, res, next) => {
  try {
    const result = await listModuleApplicationsService(req.params.caseId);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
});

// POST /api/cases/:caseId/modules
caseModulesRouter.post("/", async (req: CaseParams, res, next) => {
  try {
    const result = await applyModuleService(req.params.caseId, req.body);
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

// PATCH /api/module-applications/:moduleApplicationId
moduleApplicationsRouter.patch("/:moduleApplicationId", async (req, res, next) => {
  try {
    const result = await updateModuleApplicationService(
      req.params.moduleApplicationId!,
      req.body,
    );
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
});
