import { Router, type Request } from "express";
import { authenticate } from "../../auth/authenticate.js";
import { requireRole } from "../../auth/authorize.js";
import {
  createIssueService,
  getIssueService,
  listIssuesService,
  resolveIssueService,
  updateIssueService,
} from "./service.js";

// Mounted at /api/cases/:caseId/issues for list/create, and
// /api/issues/:issueId[/resolutions] for get/update/resolve.
export const caseIssuesRouter = Router({ mergeParams: true });
export const issuesRouter = Router();

caseIssuesRouter.use(authenticate, requireRole("BA"));
issuesRouter.use(authenticate, requireRole("BA"));

type CaseParams = Request<{ caseId: string }>;
type IssueParams = Request<{ issueId: string }>;

// GET /api/cases/:caseId/issues?status=OPEN
caseIssuesRouter.get("/", async (req: CaseParams, res, next) => {
  try {
    const result = await listIssuesService(req.params.caseId, req.query.status as string | undefined);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
});

// POST /api/cases/:caseId/issues
caseIssuesRouter.post("/", async (req: CaseParams, res, next) => {
  try {
    const result = await createIssueService(req.params.caseId, req.body, req.user!.userId);
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

// GET /api/issues/:issueId
issuesRouter.get("/:issueId", async (req: IssueParams, res, next) => {
  try {
    const result = await getIssueService(req.params.issueId);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
});

// PATCH /api/issues/:issueId
issuesRouter.patch("/:issueId", async (req: IssueParams, res, next) => {
  try {
    const result = await updateIssueService(req.params.issueId, req.body, req.user!.userId);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
});

// POST /api/issues/:issueId/resolutions
issuesRouter.post("/:issueId/resolutions", async (req: IssueParams, res, next) => {
  try {
    const result = await resolveIssueService(req.params.issueId, req.body, req.user!.userId);
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});
