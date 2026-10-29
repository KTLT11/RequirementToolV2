import { Router, type Request } from "express";
import { authenticate } from "../../auth/authenticate.js";
import { requireRole } from "../../auth/authorize.js";
import { createGapService, listGapsService, updateGapService } from "./service.js";

// Mounted at /api/cases/:caseId/gaps for list/create, and
// /api/gaps/:gapId for status updates.
export const caseGapsRouter = Router({ mergeParams: true });
export const gapsRouter = Router();

caseGapsRouter.use(authenticate, requireRole("BA"));
gapsRouter.use(authenticate, requireRole("BA"));

type CaseParams = Request<{ caseId: string }>;

// GET /api/cases/:caseId/gaps?status=OPEN
caseGapsRouter.get("/", async (req: CaseParams, res, next) => {
  try {
    const result = await listGapsService(req.params.caseId, req.query as { status?: string });
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
});

// POST /api/cases/:caseId/gaps
caseGapsRouter.post("/", async (req: CaseParams, res, next) => {
  try {
    const result = await createGapService(req.params.caseId, req.body, req.user!.userId);
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

// PATCH /api/gaps/:gapId
gapsRouter.patch("/:gapId", async (req, res, next) => {
  try {
    const result = await updateGapService(req.params.gapId!, req.body, req.user!.userId);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
});
