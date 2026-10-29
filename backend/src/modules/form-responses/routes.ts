import { Router, type Request } from "express";
import { authenticate } from "../../auth/authenticate.js";
import { requireRole } from "../../auth/authorize.js";
import { getResponseService, listResponsesService, updateResponseService } from "./service.js";

// Mounted at /api/cases/:caseId/form-responses for list, and
// /api/form-responses/:responseId for get/update.
export const caseFormResponsesRouter = Router({ mergeParams: true });
export const formResponsesRouter = Router();

caseFormResponsesRouter.use(authenticate, requireRole("BA"));
formResponsesRouter.use(authenticate, requireRole("BA"));

type CaseParams = Request<{ caseId: string }>;

// GET /api/cases/:caseId/form-responses?status=PENDING_BA_REVIEW
caseFormResponsesRouter.get("/", async (req: CaseParams, res, next) => {
  try {
    const result = await listResponsesService(req.params.caseId, req.query as { status?: string });
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
});

// GET /api/form-responses/:responseId
formResponsesRouter.get("/:responseId", async (req, res, next) => {
  try {
    const result = await getResponseService(req.params.responseId!);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
});

// PATCH /api/form-responses/:responseId
formResponsesRouter.patch("/:responseId", async (req, res, next) => {
  try {
    const result = await updateResponseService(req.params.responseId!, req.body);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
});
