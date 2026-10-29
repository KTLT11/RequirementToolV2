import { Router, type Request } from "express";
import { authenticate } from "../../auth/authenticate.js";
import { requireRole } from "../../auth/authorize.js";
import {
  createRequirementService,
  getRequirementService,
  listRequirementsService,
  splitRequirementService,
  updateRequirementService,
} from "./service.js";

// Mounted at /api/cases/:caseId/requirements for list/create, and
// /api/requirements/:requirementId for get/update/split.
export const caseRequirementsRouter = Router({ mergeParams: true });
export const requirementsRouter = Router();

caseRequirementsRouter.use(authenticate, requireRole("BA"));
requirementsRouter.use(authenticate, requireRole("BA"));

type CaseParams = Request<{ caseId: string }>;

// GET /api/cases/:caseId/requirements
caseRequirementsRouter.get("/", async (req: CaseParams, res, next) => {
  try {
    const result = await listRequirementsService(req.params.caseId);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
});

// POST /api/cases/:caseId/requirements
caseRequirementsRouter.post("/", async (req: CaseParams, res, next) => {
  try {
    const result = await createRequirementService(req.params.caseId, req.body, req.user!.userId);
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

// GET /api/requirements/:requirementId
requirementsRouter.get("/:requirementId", async (req, res, next) => {
  try {
    const result = await getRequirementService(req.params.requirementId!);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
});

// PATCH /api/requirements/:requirementId
requirementsRouter.patch("/:requirementId", async (req, res, next) => {
  try {
    const result = await updateRequirementService(
      req.params.requirementId!,
      req.body,
      req.user!.userId,
    );
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
});

// POST /api/requirements/:requirementId/split
requirementsRouter.post("/:requirementId/split", async (req, res, next) => {
  try {
    const result = await splitRequirementService(
      req.params.requirementId!,
      req.body,
      req.user!.userId,
    );
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});
