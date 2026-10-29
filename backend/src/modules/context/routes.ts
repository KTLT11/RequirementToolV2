import { Router, type Request } from "express";
import { authenticate } from "../../auth/authenticate.js";
import { requireRole } from "../../auth/authorize.js";
import { createContextService, listContextsService, updateContextService } from "./service.js";

// Mounted at /api/cases/:caseId/context for list/create, and
// separately at /api/context/:contextId for update (a context fact's
// own id is enough to address it directly once created).
//
// mergeParams: true is required for req.params.caseId to be visible
// here at all - without it, a router mounted on a parent path with
// its own :caseId param does not inherit that param.
export const caseContextRouter = Router({ mergeParams: true });
export const contextRouter = Router();

caseContextRouter.use(authenticate, requireRole("BA"));
contextRouter.use(authenticate, requireRole("BA"));

type CaseParams = Request<{ caseId: string }>;

// GET /api/cases/:caseId/context
caseContextRouter.get("/", async (req: CaseParams, res, next) => {
  try {
    const result = await listContextsService(req.params.caseId);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
});

// POST /api/cases/:caseId/context
caseContextRouter.post("/", async (req: CaseParams, res, next) => {
  try {
    const result = await createContextService(req.params.caseId, req.body, req.user!.userId);
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

// PATCH /api/context/:contextId
contextRouter.patch("/:contextId", async (req, res, next) => {
  try {
    const result = await updateContextService(req.params.contextId!, req.body, req.user!.userId);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
});
