import { Router, type Request } from "express";
import { authenticate } from "../../auth/authenticate.js";
import { requireRole } from "../../auth/authorize.js";
import {
  createCompletenessAssessmentService,
  createQualityAssessmentService,
  createReadinessAssessmentService,
  getAssessmentService,
  listAssessmentsService,
} from "./service.js";

// Mounted at /api/cases/:caseId/assessments[...] for list/create, and
// /api/assessments/:assessmentId for get.
export const caseAssessmentsRouter = Router({ mergeParams: true });
export const assessmentsRouter = Router();

caseAssessmentsRouter.use(authenticate, requireRole("BA"));
assessmentsRouter.use(authenticate, requireRole("BA"));

type CaseParams = Request<{ caseId: string }>;

// GET /api/cases/:caseId/assessments?assessment_type=QUALITY
caseAssessmentsRouter.get("/", async (req: CaseParams, res, next) => {
  try {
    const result = await listAssessmentsService(
      req.params.caseId,
      req.query.assessment_type as string | undefined,
    );
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
});

// POST /api/cases/:caseId/assessments/completeness
caseAssessmentsRouter.post("/completeness", async (req: CaseParams, res, next) => {
  try {
    const result = await createCompletenessAssessmentService(req.params.caseId, req.user!.userId);
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

// POST /api/cases/:caseId/assessments/quality
caseAssessmentsRouter.post("/quality", async (req: CaseParams, res, next) => {
  try {
    const result = await createQualityAssessmentService(req.params.caseId, req.user!.userId);
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

// POST /api/cases/:caseId/assessments/readiness
caseAssessmentsRouter.post("/readiness", async (req: CaseParams, res, next) => {
  try {
    const result = await createReadinessAssessmentService(req.params.caseId, req.user!.userId);
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

// GET /api/assessments/:assessmentId
assessmentsRouter.get("/:assessmentId", async (req, res, next) => {
  try {
    const result = await getAssessmentService(req.params.assessmentId!);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
});
