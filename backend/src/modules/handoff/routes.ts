import { Router, type Request } from "express";
import { authenticate } from "../../auth/authenticate.js";
import { requireRole } from "../../auth/authorize.js";
import {
  createDevReviewService,
  createHandoffService,
  getDevReviewService,
  getHandoffService,
  listHandoffsService,
  updateDevReviewService,
  updateHandoffStatusService,
} from "./service.js";

// Mounted at /api/cases/:caseId/handoffs for list/create, and
// /api/handoffs/:handoffId[/reviews], /api/dev-reviews/:devReviewId
// for the rest of the lifecycle.
export const caseHandoffsRouter = Router({ mergeParams: true });
export const handoffsRouter = Router();
export const devReviewsRouter = Router();

caseHandoffsRouter.use(authenticate, requireRole("BA"));
handoffsRouter.use(authenticate, requireRole("BA"));
devReviewsRouter.use(authenticate, requireRole("BA"));

type CaseParams = Request<{ caseId: string }>;
type HandoffParams = Request<{ handoffId: string }>;
type DevReviewParams = Request<{ devReviewId: string }>;

// GET /api/cases/:caseId/handoffs
caseHandoffsRouter.get("/", async (req: CaseParams, res, next) => {
  try {
    const result = await listHandoffsService(req.params.caseId);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
});

// POST /api/cases/:caseId/handoffs
caseHandoffsRouter.post("/", async (req: CaseParams, res, next) => {
  try {
    const result = await createHandoffService(req.params.caseId, req.body, req.user!.userId);
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

// GET /api/handoffs/:handoffId
handoffsRouter.get("/:handoffId", async (req: HandoffParams, res, next) => {
  try {
    const result = await getHandoffService(req.params.handoffId);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
});

// PATCH /api/handoffs/:handoffId
handoffsRouter.patch("/:handoffId", async (req: HandoffParams, res, next) => {
  try {
    const result = await updateHandoffStatusService(req.params.handoffId, req.body);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
});

// POST /api/handoffs/:handoffId/reviews
handoffsRouter.post("/:handoffId/reviews", async (req: HandoffParams, res, next) => {
  try {
    const result = await createDevReviewService(req.params.handoffId, req.body, req.user!.userId);
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

// GET /api/dev-reviews/:devReviewId
devReviewsRouter.get("/:devReviewId", async (req: DevReviewParams, res, next) => {
  try {
    const result = await getDevReviewService(req.params.devReviewId);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
});

// PATCH /api/dev-reviews/:devReviewId
devReviewsRouter.patch("/:devReviewId", async (req: DevReviewParams, res, next) => {
  try {
    const result = await updateDevReviewService(req.params.devReviewId, req.body);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
});
