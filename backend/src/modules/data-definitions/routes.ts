import { Router, type Request } from "express";
import { authenticate } from "../../auth/authenticate.js";
import { requireRole } from "../../auth/authorize.js";
import {
  createAttributeService,
  createDataDefinitionService,
  getDataDefinitionService,
  listDataDefinitionsService,
} from "./service.js";

// Mounted at /api/cases/:caseId/data-definitions for list/create, and
// /api/data-definitions/:dataDefinitionId[/attributes] for get + children.
export const caseDataDefinitionsRouter = Router({ mergeParams: true });
export const dataDefinitionsRouter = Router();

caseDataDefinitionsRouter.use(authenticate, requireRole("BA"));
dataDefinitionsRouter.use(authenticate, requireRole("BA"));

type CaseParams = Request<{ caseId: string }>;
type DataDefinitionParams = Request<{ dataDefinitionId: string }>;

// GET /api/cases/:caseId/data-definitions
caseDataDefinitionsRouter.get("/", async (req: CaseParams, res, next) => {
  try {
    const result = await listDataDefinitionsService(req.params.caseId);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
});

// POST /api/cases/:caseId/data-definitions
caseDataDefinitionsRouter.post("/", async (req: CaseParams, res, next) => {
  try {
    const result = await createDataDefinitionService(req.params.caseId, req.body, req.user!.userId);
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

// GET /api/data-definitions/:dataDefinitionId (includes attributes)
dataDefinitionsRouter.get("/:dataDefinitionId", async (req: DataDefinitionParams, res, next) => {
  try {
    const result = await getDataDefinitionService(req.params.dataDefinitionId);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
});

// POST /api/data-definitions/:dataDefinitionId/attributes
dataDefinitionsRouter.post(
  "/:dataDefinitionId/attributes",
  async (req: DataDefinitionParams, res, next) => {
    try {
      const result = await createAttributeService(
        req.params.dataDefinitionId,
        req.body,
        req.user!.userId,
      );
      res.status(201).json(result);
    } catch (err) {
      next(err);
    }
  },
);
