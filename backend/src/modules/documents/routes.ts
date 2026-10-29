import { Router, type Request } from "express";
import { authenticate } from "../../auth/authenticate.js";
import { requireRole } from "../../auth/authorize.js";
import {
  createDocumentService,
  createPublicationService,
  createSnapshotService,
  getDocumentService,
  getPublicationService,
  getSnapshotService,
  invalidateSnapshotService,
  listDocumentsService,
  updatePublicationStatusService,
} from "./service.js";

// Mounted at /api/cases/:caseId/documents for list/create, and
// /api/documents/:documentId[/snapshots], /api/snapshots/:snapshotId
// [/publications|/invalidate], /api/publications/:publicationId for
// the rest of the lifecycle.
export const caseDocumentsRouter = Router({ mergeParams: true });
export const documentsRouter = Router();
export const snapshotsRouter = Router();
export const publicationsRouter = Router();

caseDocumentsRouter.use(authenticate, requireRole("BA"));
documentsRouter.use(authenticate, requireRole("BA"));
snapshotsRouter.use(authenticate, requireRole("BA"));
publicationsRouter.use(authenticate, requireRole("BA"));

type CaseParams = Request<{ caseId: string }>;
type DocumentParams = Request<{ documentId: string }>;
type SnapshotParams = Request<{ snapshotId: string }>;
type PublicationParams = Request<{ publicationId: string }>;

// GET /api/cases/:caseId/documents
caseDocumentsRouter.get("/", async (req: CaseParams, res, next) => {
  try {
    const result = await listDocumentsService(req.params.caseId);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
});

// POST /api/cases/:caseId/documents
caseDocumentsRouter.post("/", async (req: CaseParams, res, next) => {
  try {
    const result = await createDocumentService(req.params.caseId, req.body, req.user!.userId);
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

// GET /api/documents/:documentId
documentsRouter.get("/:documentId", async (req: DocumentParams, res, next) => {
  try {
    const result = await getDocumentService(req.params.documentId);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
});

// POST /api/documents/:documentId/snapshots
documentsRouter.post("/:documentId/snapshots", async (req: DocumentParams, res, next) => {
  try {
    const result = await createSnapshotService(req.params.documentId, req.body, req.user!.userId);
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

// GET /api/snapshots/:snapshotId
snapshotsRouter.get("/:snapshotId", async (req: SnapshotParams, res, next) => {
  try {
    const result = await getSnapshotService(req.params.snapshotId);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
});

// PATCH /api/snapshots/:snapshotId/invalidate
snapshotsRouter.patch("/:snapshotId/invalidate", async (req: SnapshotParams, res, next) => {
  try {
    const result = await invalidateSnapshotService(req.params.snapshotId, req.body);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
});

// POST /api/snapshots/:snapshotId/publications
snapshotsRouter.post("/:snapshotId/publications", async (req: SnapshotParams, res, next) => {
  try {
    const result = await createPublicationService(req.params.snapshotId, req.body, req.user!.userId);
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

// GET /api/publications/:publicationId
publicationsRouter.get("/:publicationId", async (req: PublicationParams, res, next) => {
  try {
    const result = await getPublicationService(req.params.publicationId);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
});

// PATCH /api/publications/:publicationId
publicationsRouter.patch("/:publicationId", async (req: PublicationParams, res, next) => {
  try {
    const result = await updatePublicationStatusService(req.params.publicationId, req.body);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
});
