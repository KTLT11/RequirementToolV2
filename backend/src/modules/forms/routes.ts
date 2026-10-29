import { Router, type Request } from "express";
import { authenticate } from "../../auth/authenticate.js";
import { requireRole } from "../../auth/authorize.js";
import {
  createFormService,
  createGrantService,
  createVersionService,
  getVersionService,
  listFormsService,
  revokeGrantService,
  updateVersionStatusService,
} from "./service.js";

// Mounted at /api/cases/:caseId/forms for list/create, and
// /api/forms/:formId/versions[...], /api/grants/:grantId for the
// rest of the lifecycle.
export const caseFormsRouter = Router({ mergeParams: true });
export const formsRouter = Router();
export const grantsRouter = Router();

caseFormsRouter.use(authenticate, requireRole("BA"));
formsRouter.use(authenticate, requireRole("BA"));
grantsRouter.use(authenticate, requireRole("BA"));

type CaseParams = Request<{ caseId: string }>;
type FormParams = Request<{ formId: string }>;
type VersionParams = Request<{ versionId: string }>;

// GET /api/cases/:caseId/forms
caseFormsRouter.get("/", async (req: CaseParams, res, next) => {
  try {
    const result = await listFormsService(req.params.caseId);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
});

// POST /api/cases/:caseId/forms
caseFormsRouter.post("/", async (req: CaseParams, res, next) => {
  try {
    const result = await createFormService(req.params.caseId, req.body, req.user!.userId);
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

// POST /api/forms/:formId/versions
formsRouter.post("/:formId/versions", async (req: FormParams, res, next) => {
  try {
    const result = await createVersionService(req.params.formId, req.body);
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

// GET /api/forms/:formId/versions/:versionId
formsRouter.get(
  "/:formId/versions/:versionId",
  async (req: FormParams & VersionParams, res, next) => {
    try {
      const result = await getVersionService(req.params.versionId);
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  },
);

// PATCH /api/forms/:formId/versions/:versionId
formsRouter.patch(
  "/:formId/versions/:versionId",
  async (req: FormParams & VersionParams, res, next) => {
    try {
      const result = await updateVersionStatusService(req.params.versionId, req.body);
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  },
);

// POST /api/forms/:formId/versions/:versionId/grants
formsRouter.post(
  "/:formId/versions/:versionId/grants",
  async (req: FormParams & VersionParams, res, next) => {
    try {
      const result = await createGrantService(req.params.versionId, req.body);
      res.status(201).json(result);
    } catch (err) {
      next(err);
    }
  },
);

// PATCH /api/grants/:grantId
grantsRouter.patch("/:grantId", async (req, res, next) => {
  try {
    const result = await revokeGrantService(req.params.grantId!);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
});
