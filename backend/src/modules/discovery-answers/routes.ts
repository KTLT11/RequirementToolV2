import { Router, type Request } from "express";
import { authenticate } from "../../auth/authenticate.js";
import { requireRole } from "../../auth/authorize.js";
import { createAnswerService, listAnswersService, updateAnswerService } from "./service.js";

// Mounted at /api/cases/:caseId/discovery-answers for list/create,
// and /api/discovery-answers/:answerId for update.
export const caseAnswersRouter = Router({ mergeParams: true });
export const answersRouter = Router();

caseAnswersRouter.use(authenticate, requireRole("BA"));
answersRouter.use(authenticate, requireRole("BA"));

type CaseParams = Request<{ caseId: string }>;

// GET /api/cases/:caseId/discovery-answers
caseAnswersRouter.get("/", async (req: CaseParams, res, next) => {
  try {
    const result = await listAnswersService(req.params.caseId);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
});

// POST /api/cases/:caseId/discovery-answers
caseAnswersRouter.post("/", async (req: CaseParams, res, next) => {
  try {
    const result = await createAnswerService(req.params.caseId, req.body, req.user!.userId);
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

// PATCH /api/discovery-answers/:answerId
answersRouter.patch("/:answerId", async (req, res, next) => {
  try {
    const result = await updateAnswerService(req.params.answerId!, req.body, req.user!.userId);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
});
