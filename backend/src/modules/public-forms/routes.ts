import { Router } from "express";
import { getPublicFormService, submitFormResponseService } from "./service.js";

// Mounted at /api/public/forms — deliberately NOT given
// authenticate()/requireRole() middleware, per FR-012 ("stakeholder
// submits via a shared link without logging in"). The only gate here
// is the opaque token itself, verified inside the service layer
// against public_access_grants.token_hash.
export const publicFormsRouter = Router();

// GET /api/public/forms/:token
publicFormsRouter.get("/:token", async (req, res, next) => {
  try {
    const result = await getPublicFormService(req.params.token!);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
});

// POST /api/public/forms/:token/responses
publicFormsRouter.post("/:token/responses", async (req, res, next) => {
  try {
    const result = await submitFormResponseService(req.params.token!, req.body);
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});
