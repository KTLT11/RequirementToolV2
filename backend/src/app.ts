// Express app construction, separated from server.ts's port-binding
// so integration tests can import and exercise the app directly
// (via supertest-style requests or a listen() on an ephemeral port)
// without needing a separately-running `npm run dev` process or
// risking a port collision with one.

import express, { type ErrorRequestHandler } from "express";
import { authRouter } from "./auth/routes.js";
import { corsMiddleware } from "./http/cors.js";
import { HttpError } from "./http/errors.js";
import { casesRouter } from "./modules/cases/routes.js";
import { caseContextRouter, contextRouter } from "./modules/context/routes.js";
import { caseScopeRouter } from "./modules/scope/routes.js";
import { caseModulesRouter, moduleApplicationsRouter } from "./modules/module-applications/routes.js";
import { caseAnswersRouter, answersRouter } from "./modules/discovery-answers/routes.js";
import { caseGapsRouter, gapsRouter } from "./modules/information-gaps/routes.js";
import { definitionsRouter } from "./modules/definitions/routes.js";
import { caseRequirementsRouter, requirementsRouter } from "./modules/requirements/routes.js";
import { requirementAcRouter, acRouter } from "./modules/acceptance-criteria/routes.js";
import { caseRulesRouter, rulesRouter } from "./modules/business-rules/routes.js";
import { caseWorkflowsRouter, workflowsRouter } from "./modules/workflows/routes.js";
import { caseDataDefinitionsRouter, dataDefinitionsRouter } from "./modules/data-definitions/routes.js";
import { stakeholdersRouter } from "./modules/stakeholders/routes.js";
import { caseStakeholdersRouter, caseStakeholderChildrenRouter } from "./modules/case-stakeholders/routes.js";
import { caseFormsRouter, formsRouter, grantsRouter } from "./modules/forms/routes.js";
import { publicFormsRouter } from "./modules/public-forms/routes.js";
import { caseFormResponsesRouter, formResponsesRouter } from "./modules/form-responses/routes.js";
import { caseEvidenceRouter, evidenceRouter } from "./modules/evidence/routes.js";
import { caseDecisionsRouter, decisionsRouter } from "./modules/business-decisions/routes.js";
import { entitiesRouter } from "./modules/entities/routes.js";
import { relationsRouter } from "./modules/traceability/routes.js";
import { caseValidationRunsRouter, validationRunsRouter } from "./modules/validation/routes.js";
import { caseIssuesRouter, issuesRouter } from "./modules/issues/routes.js";
import { caseAssessmentsRouter, assessmentsRouter } from "./modules/assessment/routes.js";
import {
  caseDocumentsRouter,
  documentsRouter,
  snapshotsRouter,
  publicationsRouter,
} from "./modules/documents/routes.js";
import {
  publicationConfirmationsRouter,
  confirmationsRouter,
} from "./modules/confirmations/routes.js";
import {
  caseHandoffsRouter,
  handoffsRouter,
  devReviewsRouter,
} from "./modules/handoff/routes.js";

export function createApp(): express.Express {
  const app = express();

  app.use(corsMiddleware);
  app.use(express.json());

  app.get("/api/health", (_req, res) => {
    res.status(200).json({ data: { status: "ok" } });
  });

  app.use("/api/auth", authRouter);
  app.use("/api/cases", casesRouter);
  app.use("/api/cases/:caseId/context", caseContextRouter);
  app.use("/api/context", contextRouter);
  app.use("/api/cases/:caseId/scope", caseScopeRouter);
  app.use("/api/cases/:caseId/modules", caseModulesRouter);
  app.use("/api/module-applications", moduleApplicationsRouter);
  app.use("/api/cases/:caseId/discovery-answers", caseAnswersRouter);
  app.use("/api/discovery-answers", answersRouter);
  app.use("/api/cases/:caseId/gaps", caseGapsRouter);
  app.use("/api/gaps", gapsRouter);
  app.use("/api/definitions", definitionsRouter);
  app.use("/api/cases/:caseId/requirements", caseRequirementsRouter);
  app.use("/api/requirements", requirementsRouter);
  app.use("/api/requirements/:requirementId/acceptance-criteria", requirementAcRouter);
  app.use("/api/acceptance-criteria", acRouter);
  app.use("/api/cases/:caseId/business-rules", caseRulesRouter);
  app.use("/api/business-rules", rulesRouter);
  app.use("/api/cases/:caseId/workflows", caseWorkflowsRouter);
  app.use("/api/workflows", workflowsRouter);
  app.use("/api/cases/:caseId/data-definitions", caseDataDefinitionsRouter);
  app.use("/api/data-definitions", dataDefinitionsRouter);
  app.use("/api/stakeholders", stakeholdersRouter);
  app.use("/api/cases/:caseId/stakeholders", caseStakeholdersRouter);
  app.use("/api/case-stakeholders", caseStakeholderChildrenRouter);
  app.use("/api/cases/:caseId/forms", caseFormsRouter);
  app.use("/api/forms", formsRouter);
  app.use("/api/grants", grantsRouter);
  app.use("/api/public/forms", publicFormsRouter);
  app.use("/api/cases/:caseId/form-responses", caseFormResponsesRouter);
  app.use("/api/form-responses", formResponsesRouter);
  app.use("/api/cases/:caseId/evidence", caseEvidenceRouter);
  app.use("/api/evidence", evidenceRouter);
  app.use("/api/cases/:caseId/decisions", caseDecisionsRouter);
  app.use("/api/decisions", decisionsRouter);
  app.use("/api/entities", entitiesRouter);
  app.use("/api/relations", relationsRouter);
  app.use("/api/cases/:caseId/validation-runs", caseValidationRunsRouter);
  app.use("/api/validation-runs", validationRunsRouter);
  app.use("/api/cases/:caseId/issues", caseIssuesRouter);
  app.use("/api/issues", issuesRouter);
  app.use("/api/cases/:caseId/assessments", caseAssessmentsRouter);
  app.use("/api/assessments", assessmentsRouter);
  app.use("/api/cases/:caseId/documents", caseDocumentsRouter);
  app.use("/api/documents", documentsRouter);
  app.use("/api/snapshots", snapshotsRouter);
  app.use("/api/publications", publicationsRouter);
  app.use("/api/publications/:publicationId/confirmations", publicationConfirmationsRouter);
  app.use("/api/confirmations", confirmationsRouter);
  app.use("/api/cases/:caseId/handoffs", caseHandoffsRouter);
  app.use("/api/handoffs", handoffsRouter);
  app.use("/api/dev-reviews", devReviewsRouter);

  app.use((_req, res) => {
    res.status(404).json({
      error: { code: "NOT_FOUND", message: "Route not found" },
    });
  });

  // Centralized error handler - every route/middleware calls
  // next(err) instead of building its own response, so the error
  // contract (same { error: { code, message } } shape the old Edge
  // Function used) is enforced in exactly one place.
  const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: { code: err.code, message: err.message } });
      return;
    }

    // Anything else (a bug, a raw Postgres error that wasn't
    // translated by a service function) is logged server-side and
    // never leaks its raw message to the client - matches the old
    // Edge Function's withErrorBoundary behavior.
    console.error("Unhandled error:", err);
    res.status(500).json({
      error: {
        code: "INTERNAL_ERROR",
        message: "An unexpected error occurred. Please try again later.",
      },
    });
  };

  app.use(errorHandler);

  return app;
}
