import { Router } from "express";
import { authenticate } from "../../auth/authenticate.js";
import { requireRole } from "../../auth/authorize.js";
import {
  createCaseService,
  getCaseService,
  listCasesService,
  updateCaseService,
} from "./service.js";

export const casesRouter = Router();

// Every route requires an authenticated BA. authorize.ts is the only
// place that encodes "which role can do this" - if Case-level
// permissions are added later (e.g. only the owning BA can update a
// given Case), that logic is added to authorize.ts, not here.
casesRouter.use(authenticate, requireRole("BA"));

// GET /api/cases
casesRouter.get("/", async (req, res, next) => {
  try {
    const result = await listCasesService(req.query as Record<string, string>);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
});

// GET /api/cases/:caseId
casesRouter.get("/:caseId", async (req, res, next) => {
  try {
    const result = await getCaseService(req.params.caseId!);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
});

// POST /api/cases
casesRouter.post("/", async (req, res, next) => {
  try {
    // callerUserId always comes from req.user, populated by
    // authenticate() from the validated session - never from the
    // request body, even if a client sent one.
    const result = await createCaseService(req.body, req.user!.userId);
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

// PATCH /api/cases/:caseId
casesRouter.patch("/:caseId", async (req, res, next) => {
  try {
    const result = await updateCaseService(
      req.params.caseId!,
      req.body,
      req.user!.userId,
    );
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
});
