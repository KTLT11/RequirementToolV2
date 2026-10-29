import { Router, type Request } from "express";
import { authenticate } from "../../auth/authenticate.js";
import { requireRole } from "../../auth/authorize.js";
import { addCaseStakeholderService, addRoleService, grantAuthorityService, listCaseStakeholdersService } from "./service.js";

// Mounted at /api/cases/:caseId/stakeholders for list/add, and
// /api/case-stakeholders/:caseStakeholderId[/roles|/authority] for
// children.
export const caseStakeholdersRouter = Router({ mergeParams: true });
export const caseStakeholderChildrenRouter = Router();

caseStakeholdersRouter.use(authenticate, requireRole("BA"));
caseStakeholderChildrenRouter.use(authenticate, requireRole("BA"));

type CaseParams = Request<{ caseId: string }>;
type CaseStakeholderParams = Request<{ caseStakeholderId: string }>;

// GET /api/cases/:caseId/stakeholders
caseStakeholdersRouter.get("/", async (req: CaseParams, res, next) => {
  try {
    const result = await listCaseStakeholdersService(req.params.caseId);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
});

// POST /api/cases/:caseId/stakeholders
caseStakeholdersRouter.post("/", async (req: CaseParams, res, next) => {
  try {
    const result = await addCaseStakeholderService(req.params.caseId, req.body, req.user!.userId);
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

// POST /api/case-stakeholders/:caseStakeholderId/roles
caseStakeholderChildrenRouter.post(
  "/:caseStakeholderId/roles",
  async (req: CaseStakeholderParams, res, next) => {
    try {
      const result = await addRoleService(req.params.caseStakeholderId, req.body, req.user!.userId);
      res.status(201).json(result);
    } catch (err) {
      next(err);
    }
  },
);

// POST /api/case-stakeholders/:caseStakeholderId/authority
caseStakeholderChildrenRouter.post(
  "/:caseStakeholderId/authority",
  async (req: CaseStakeholderParams, res, next) => {
    try {
      const result = await grantAuthorityService(
        req.params.caseStakeholderId,
        req.body,
        req.user!.userId,
      );
      res.status(201).json(result);
    } catch (err) {
      next(err);
    }
  },
);
