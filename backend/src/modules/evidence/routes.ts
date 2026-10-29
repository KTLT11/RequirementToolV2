import { Router, type Request } from "express";
import { authenticate } from "../../auth/authenticate.js";
import { requireRole } from "../../auth/authorize.js";
import {
  confirmEvidenceService,
  createEvidenceService,
  getEvidenceService,
  listEvidenceService,
  reviewEvidenceService,
} from "./service.js";

// Mounted at /api/cases/:caseId/evidence for list/create, and
// /api/evidence/:evidenceId[/reviews|/confirmations] for children.
export const caseEvidenceRouter = Router({ mergeParams: true });
export const evidenceRouter = Router();

caseEvidenceRouter.use(authenticate, requireRole("BA"));
evidenceRouter.use(authenticate, requireRole("BA"));

type CaseParams = Request<{ caseId: string }>;
type EvidenceParams = Request<{ evidenceId: string }>;

// GET /api/cases/:caseId/evidence
caseEvidenceRouter.get("/", async (req: CaseParams, res, next) => {
  try {
    const result = await listEvidenceService(req.params.caseId);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
});

// POST /api/cases/:caseId/evidence
caseEvidenceRouter.post("/", async (req: CaseParams, res, next) => {
  try {
    const result = await createEvidenceService(req.params.caseId, req.body, req.user!.userId);
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

// GET /api/evidence/:evidenceId
evidenceRouter.get("/:evidenceId", async (req: EvidenceParams, res, next) => {
  try {
    const result = await getEvidenceService(req.params.evidenceId);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
});

// POST /api/evidence/:evidenceId/reviews
evidenceRouter.post("/:evidenceId/reviews", async (req: EvidenceParams, res, next) => {
  try {
    const result = await reviewEvidenceService(req.params.evidenceId, req.body, req.user!.userId);
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

// POST /api/evidence/:evidenceId/confirmations
evidenceRouter.post("/:evidenceId/confirmations", async (req: EvidenceParams, res, next) => {
  try {
    const result = await confirmEvidenceService(req.params.evidenceId, req.body, req.user!.userId);
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});
