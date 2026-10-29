import { Router } from "express";
import { authenticate } from "../../auth/authenticate.js";
import { requireRole } from "../../auth/authorize.js";
import { createRelationService } from "./service.js";

// Generic Traceability API (P3-FR-016). Mounted at /api/relations.
// Used by a BA to create any approved RELATION_TYPE link between two
// entities - currently DECISION_SUPPORTS_REQUIREMENT is the only one
// created this way (see service.ts docblock for why
// EVIDENCE_SUPPORTS_DECISION is NOT created through this route). The
// read-only per-entity lookup lives separately at GET
// /api/entities/:entityId/relations (src/modules/entities/routes.ts),
// which already calls repository.findRelationsByEntityId directly.
export const relationsRouter = Router();

relationsRouter.use(authenticate, requireRole("BA"));

relationsRouter.post("/", async (req, res, next) => {
  try {
    const result = await createRelationService(req.body, req.user!.userId);
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});
