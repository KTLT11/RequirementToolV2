import { Router, type Request } from "express";
import { authenticate } from "../../auth/authenticate.js";
import { requireRole } from "../../auth/authorize.js";
import { createAcService, listAcService, updateAcService } from "./service.js";

// Mounted at /api/requirements/:requirementId/acceptance-criteria for
// list/create, and /api/acceptance-criteria/:acId for update.
export const requirementAcRouter = Router({ mergeParams: true });
export const acRouter = Router();

requirementAcRouter.use(authenticate, requireRole("BA"));
acRouter.use(authenticate, requireRole("BA"));

type RequirementParams = Request<{ requirementId: string }>;

// GET /api/requirements/:requirementId/acceptance-criteria
requirementAcRouter.get("/", async (req: RequirementParams, res, next) => {
  try {
    const result = await listAcService(req.params.requirementId);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
});

// POST /api/requirements/:requirementId/acceptance-criteria
requirementAcRouter.post("/", async (req: RequirementParams, res, next) => {
  try {
    const result = await createAcService(req.params.requirementId, req.body, req.user!.userId);
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

// PATCH /api/acceptance-criteria/:acId
acRouter.patch("/:acId", async (req, res, next) => {
  try {
    const result = await updateAcService(req.params.acId!, req.body, req.user!.userId);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
});
