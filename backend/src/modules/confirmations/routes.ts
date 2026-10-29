import { Router, type Request } from "express";
import { authenticate } from "../../auth/authenticate.js";
import { requireRole } from "../../auth/authorize.js";
import {
  createConfirmationService,
  getConfirmationService,
  listConfirmationsByPublicationService,
} from "./service.js";

// Mounted at /api/publications/:publicationId/confirmations for
// list/create, and /api/confirmations/:confirmationId for get.
export const publicationConfirmationsRouter = Router({ mergeParams: true });
export const confirmationsRouter = Router();

publicationConfirmationsRouter.use(authenticate, requireRole("BA"));
confirmationsRouter.use(authenticate, requireRole("BA"));

type PublicationParams = Request<{ publicationId: string }>;

// GET /api/publications/:publicationId/confirmations
publicationConfirmationsRouter.get("/", async (req: PublicationParams, res, next) => {
  try {
    const result = await listConfirmationsByPublicationService(req.params.publicationId);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
});

// POST /api/publications/:publicationId/confirmations
publicationConfirmationsRouter.post("/", async (req: PublicationParams, res, next) => {
  try {
    const result = await createConfirmationService(req.params.publicationId, req.body, req.user!.userId);
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

// GET /api/confirmations/:confirmationId
confirmationsRouter.get("/:confirmationId", async (req, res, next) => {
  try {
    const result = await getConfirmationService(req.params.confirmationId!);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
});
