import { Router, type Request } from "express";
import { authenticate } from "../../auth/authenticate.js";
import { requireRole } from "../../auth/authorize.js";
import { createRuleService, listRulesService, updateRuleService } from "./service.js";

// Mounted at /api/cases/:caseId/business-rules for list/create, and
// /api/business-rules/:ruleId for update.
export const caseRulesRouter = Router({ mergeParams: true });
export const rulesRouter = Router();

caseRulesRouter.use(authenticate, requireRole("BA"));
rulesRouter.use(authenticate, requireRole("BA"));

type CaseParams = Request<{ caseId: string }>;

// GET /api/cases/:caseId/business-rules
caseRulesRouter.get("/", async (req: CaseParams, res, next) => {
  try {
    const result = await listRulesService(req.params.caseId);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
});

// POST /api/cases/:caseId/business-rules
caseRulesRouter.post("/", async (req: CaseParams, res, next) => {
  try {
    const result = await createRuleService(req.params.caseId, req.body, req.user!.userId);
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

// PATCH /api/business-rules/:ruleId
rulesRouter.patch("/:ruleId", async (req, res, next) => {
  try {
    const result = await updateRuleService(req.params.ruleId!, req.body, req.user!.userId);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
});
