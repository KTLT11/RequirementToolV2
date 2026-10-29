import { Router } from "express";
import { authenticate } from "../../auth/authenticate.js";
import { requireRole } from "../../auth/authorize.js";
import { listRelationsForEntityService } from "../traceability/service.js";

// Mounted at /api/entities — read-only traceability lookup (FR-016
// AC-01). Not scoped to any one Case, since relations can legitimately
// cross Cases (see the comment on findRelationsByEntityId).
export const entitiesRouter = Router();

entitiesRouter.use(authenticate, requireRole("BA"));

// GET /api/entities/:entityId/relations
entitiesRouter.get("/:entityId/relations", async (req, res, next) => {
  try {
    const result = await listRelationsForEntityService(req.params.entityId!);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
});
