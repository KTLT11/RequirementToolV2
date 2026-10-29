import { Router } from "express";
import { authenticate } from "../../auth/authenticate.js";
import { requireRole } from "../../auth/authorize.js";
import { HttpError } from "../../http/errors.js";
import { listDefinitionsByType } from "./repository.js";

// Read-only Rule Registry access. No admin API (create/update) exists
// here per FR-023 AC-04 / FR-023B AC-04 - this exists only so a
// caller can discover which definition_version_id values are valid
// to reference from Module Application / Discovery Answer, without
// needing direct DB access or hardcoded ids.
export const definitionsRouter = Router();

definitionsRouter.use(authenticate, requireRole("BA"));

const ALLOWED_TYPES = ["MODULE", "QUESTION", "CHECK_RULE", "RELATION_TYPE", "POLICY", "TEMPLATE"];

// GET /api/definitions?type=MODULE
definitionsRouter.get("/", async (req, res, next) => {
  try {
    const type = req.query["type"];
    if (typeof type !== "string" || !ALLOWED_TYPES.includes(type)) {
      throw new HttpError("VALIDATION_ERROR", `type must be one of: ${ALLOWED_TYPES.join(", ")}`);
    }
    const rows = await listDefinitionsByType(type);
    res.status(200).json({ data: rows });
  } catch (err) {
    next(err);
  }
});
