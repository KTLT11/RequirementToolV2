import { Router } from "express";
import { authenticate } from "../../auth/authenticate.js";
import { requireRole } from "../../auth/authorize.js";
import { createStakeholderService, getStakeholderService, listStakeholdersService } from "./service.js";

// Mounted at /api/stakeholders — not scoped to any Case.
export const stakeholdersRouter = Router();

stakeholdersRouter.use(authenticate, requireRole("BA"));

// GET /api/stakeholders
stakeholdersRouter.get("/", async (_req, res, next) => {
  try {
    const result = await listStakeholdersService();
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
});

// POST /api/stakeholders
stakeholdersRouter.post("/", async (req, res, next) => {
  try {
    const result = await createStakeholderService(req.body);
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

// GET /api/stakeholders/:stakeholderId
stakeholdersRouter.get("/:stakeholderId", async (req, res, next) => {
  try {
    const result = await getStakeholderService(req.params.stakeholderId!);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
});
