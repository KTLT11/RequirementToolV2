import type { PoolClient } from "pg";
import { getPool } from "../../db/pool.js";

export interface DocumentRow {
  document_id: string;
  case_id: string;
  document_type: string;
  document_name: string;
  document_status: string;
  created_at: string;
  created_by: string;
}

export async function findDocumentsByCaseId(caseId: string): Promise<DocumentRow[]> {
  const { rows } = await getPool().query<DocumentRow>(
    `SELECT document_id, case_id, document_type, document_name, document_status,
            created_at, created_by
     FROM documents
     WHERE case_id = $1
     ORDER BY created_at ASC`,
    [caseId],
  );
  return rows;
}

export async function findDocumentById(documentId: string): Promise<DocumentRow | null> {
  const { rows } = await getPool().query<DocumentRow>(
    `SELECT document_id, case_id, document_type, document_name, document_status,
            created_at, created_by
     FROM documents
     WHERE document_id = $1`,
    [documentId],
  );
  return rows[0] ?? null;
}

export async function insertDocument(
  client: PoolClient,
  params: { caseId: string; documentType: string; documentName: string; createdBy: string },
): Promise<DocumentRow> {
  const { rows } = await client.query<DocumentRow>(
    `INSERT INTO documents (case_id, document_type, document_name, created_by)
     VALUES ($1, $2, $3, $4)
     RETURNING document_id, case_id, document_type, document_name, document_status,
               created_at, created_by`,
    [params.caseId, params.documentType, params.documentName, params.createdBy],
  );
  return rows[0]!;
}

export async function updateDocumentStatus(
  client: PoolClient,
  params: { documentId: string; documentStatus: string },
): Promise<DocumentRow | null> {
  const { rows } = await client.query<DocumentRow>(
    `UPDATE documents SET document_status = $2
     WHERE document_id = $1
     RETURNING document_id, case_id, document_type, document_name, document_status,
               created_at, created_by`,
    [params.documentId, params.documentStatus],
  );
  return rows[0] ?? null;
}

export interface DocumentSnapshotRow {
  snapshot_id: string;
  document_id: string;
  manifest_id: string;
  snapshot_version: number;
  storage_object_path: string;
  content_sha256: string;
  content_mime_type: string;
  rendered_at: string;
  rendered_by: string;
  render_status: string;
}

export async function findMaxSnapshotVersion(documentId: string): Promise<number> {
  const { rows } = await getPool().query<{ max: number | null }>(
    `SELECT max(snapshot_version) AS max FROM document_snapshots WHERE document_id = $1`,
    [documentId],
  );
  return rows[0]?.max ?? 0;
}

/**
 * Inserts a document snapshot. Always created with render_status =
 * 'FROZEN' (rt_protect_document_snapshot permits no other starting
 * value implicitly, since the only transition it allows is FROZEN ->
 * INVALIDATED - there is no path to create one already INVALIDATED).
 * manifest_id must already reference a FROZEN, manifest_purpose=
 * 'DOCUMENT' manifest of the same case_id as the document
 * (rt_snapshot_manifest_state / rt_check_snapshot_case) - the service
 * always freezes that manifest in the same transaction, before this
 * insert.
 */
export async function insertDocumentSnapshot(
  client: PoolClient,
  params: {
    documentId: string;
    manifestId: string;
    snapshotVersion: number;
    storageObjectPath: string;
    contentSha256: string;
    contentMimeType: string;
    renderedBy: string;
  },
): Promise<DocumentSnapshotRow> {
  const { rows } = await client.query<DocumentSnapshotRow>(
    `INSERT INTO document_snapshots
       (document_id, manifest_id, snapshot_version, storage_object_path, content_sha256,
        content_mime_type, rendered_at, rendered_by, render_status)
     VALUES ($1, $2, $3, $4, $5, $6, now(), $7, 'FROZEN')
     RETURNING snapshot_id, document_id, manifest_id, snapshot_version, storage_object_path,
               content_sha256, content_mime_type, rendered_at, rendered_by, render_status`,
    [
      params.documentId,
      params.manifestId,
      params.snapshotVersion,
      params.storageObjectPath,
      params.contentSha256,
      params.contentMimeType,
      params.renderedBy,
    ],
  );
  return rows[0]!;
}

/**
 * Persists a snapshot's frozen structured content (migration 019's
 * document_snapshot_contents - see that migration's comment for why
 * this table exists). Must run in the SAME transaction as
 * insertDocumentSnapshot, since a snapshot row is never meaningful
 * without its content and vice versa - service.ts's
 * createSnapshotService writes both inside one withTransaction call.
 * content must already be the EXACT value whose canonical
 * serialization produced content_sha256 on the parent row - see
 * canonicalSerialize() in service.ts, which both the hash computation
 * and this insert use, so the two can never diverge.
 */
export async function insertSnapshotContent(
  client: PoolClient,
  params: { snapshotId: string; content: unknown },
): Promise<void> {
  await client.query(
    `INSERT INTO document_snapshot_contents (snapshot_id, content) VALUES ($1, $2::jsonb)`,
    [params.snapshotId, JSON.stringify(params.content)],
  );
}

/**
 * Reads back a snapshot's frozen content exactly as stored - this is
 * the ONLY way snapshot content is ever returned. It never
 * reconstructs or re-derives content from current canonical business
 * data (that would defeat the entire point of a frozen snapshot).
 */
export async function findSnapshotContent(snapshotId: string): Promise<unknown | null> {
  const { rows } = await getPool().query<{ content: unknown }>(
    `SELECT content FROM document_snapshot_contents WHERE snapshot_id = $1`,
    [snapshotId],
  );
  return rows[0]?.content ?? null;
}

export async function findSnapshotById(snapshotId: string): Promise<DocumentSnapshotRow | null> {
  const { rows } = await getPool().query<DocumentSnapshotRow>(
    `SELECT snapshot_id, document_id, manifest_id, snapshot_version, storage_object_path,
            content_sha256, content_mime_type, rendered_at, rendered_by, render_status
     FROM document_snapshots
     WHERE snapshot_id = $1`,
    [snapshotId],
  );
  return rows[0] ?? null;
}

export async function findSnapshotsByDocumentId(documentId: string): Promise<DocumentSnapshotRow[]> {
  const { rows } = await getPool().query<DocumentSnapshotRow>(
    `SELECT snapshot_id, document_id, manifest_id, snapshot_version, storage_object_path,
            content_sha256, content_mime_type, rendered_at, rendered_by, render_status
     FROM document_snapshots
     WHERE document_id = $1
     ORDER BY snapshot_version ASC`,
    [documentId],
  );
  return rows;
}

/**
 * The only mutation rt_protect_document_snapshot allows: render_status
 * FROZEN -> INVALIDATED. Used when a later change to source data means
 * a previously rendered snapshot no longer reflects canonical content
 * (FR-029 AC-02/AC-03's "re-review required" posture) - the snapshot
 * itself is never edited, only marked invalid; a new snapshot/version
 * is created separately if a fresh render is needed.
 */
export async function invalidateSnapshot(
  client: PoolClient,
  params: { snapshotId: string },
): Promise<DocumentSnapshotRow | null> {
  const { rows } = await client.query<DocumentSnapshotRow>(
    `UPDATE document_snapshots SET render_status = 'INVALIDATED'
     WHERE snapshot_id = $1
     RETURNING snapshot_id, document_id, manifest_id, snapshot_version, storage_object_path,
               content_sha256, content_mime_type, rendered_at, rendered_by, render_status`,
    [params.snapshotId],
  );
  return rows[0] ?? null;
}

export interface DocumentPublicationRow {
  publication_id: string;
  document_id: string;
  snapshot_id: string;
  publication_version: number;
  publication_purpose: string;
  recipient_scope: string;
  publication_status: string;
  published_at: string;
  published_by: string;
  transmission_reference: string | null;
}

export async function findMaxPublicationVersion(documentId: string): Promise<number> {
  const { rows } = await getPool().query<{ max: number | null }>(
    `SELECT max(publication_version) AS max FROM document_publications WHERE document_id = $1`,
    [documentId],
  );
  return rows[0]?.max ?? 0;
}

/**
 * Creates a publication. Always INSERTed with publication_status =
 * 'PUBLISHED' (rt_guard_document_publication requires exactly this for
 * a new row) - the snapshot and its manifest must both already be
 * FROZEN, enforced by the trigger as the final authority; the service
 * only ever passes an already-FROZEN snapshot_id here.
 */
export async function insertPublication(
  client: PoolClient,
  params: {
    documentId: string;
    snapshotId: string;
    publicationVersion: number;
    publicationPurpose: string;
    recipientScope: string;
    publishedBy: string;
    transmissionReference: string | null;
  },
): Promise<DocumentPublicationRow> {
  const { rows } = await client.query<DocumentPublicationRow>(
    `INSERT INTO document_publications
       (document_id, snapshot_id, publication_version, publication_purpose, recipient_scope,
        publication_status, published_at, published_by, transmission_reference)
     VALUES ($1, $2, $3, $4, $5, 'PUBLISHED', now(), $6, $7)
     RETURNING publication_id, document_id, snapshot_id, publication_version,
               publication_purpose, recipient_scope, publication_status, published_at,
               published_by, transmission_reference`,
    [
      params.documentId,
      params.snapshotId,
      params.publicationVersion,
      params.publicationPurpose,
      params.recipientScope,
      params.publishedBy,
      params.transmissionReference,
    ],
  );
  return rows[0]!;
}

export async function findPublicationById(publicationId: string): Promise<DocumentPublicationRow | null> {
  const { rows } = await getPool().query<DocumentPublicationRow>(
    `SELECT publication_id, document_id, snapshot_id, publication_version,
            publication_purpose, recipient_scope, publication_status, published_at,
            published_by, transmission_reference
     FROM document_publications
     WHERE publication_id = $1`,
    [publicationId],
  );
  return rows[0] ?? null;
}

export async function findPublicationsByDocumentId(
  documentId: string,
): Promise<DocumentPublicationRow[]> {
  const { rows } = await getPool().query<DocumentPublicationRow>(
    `SELECT publication_id, document_id, snapshot_id, publication_version,
            publication_purpose, recipient_scope, publication_status, published_at,
            published_by, transmission_reference
     FROM document_publications
     WHERE document_id = $1
     ORDER BY publication_version ASC`,
    [documentId],
  );
  return rows;
}

/**
 * The only mutation rt_guard_document_publication allows on an
 * existing row: publication_status PUBLISHED -> WITHDRAWN or
 * PUBLISHED -> SUPERSEDED. Every other column is immutable by trigger.
 */
export async function updatePublicationStatus(
  client: PoolClient,
  params: { publicationId: string; publicationStatus: "WITHDRAWN" | "SUPERSEDED" },
): Promise<DocumentPublicationRow | null> {
  const { rows } = await client.query<DocumentPublicationRow>(
    `UPDATE document_publications SET publication_status = $2
     WHERE publication_id = $1
     RETURNING publication_id, document_id, snapshot_id, publication_version,
               publication_purpose, recipient_scope, publication_status, published_at,
               published_by, transmission_reference`,
    [params.publicationId, params.publicationStatus],
  );
  return rows[0] ?? null;
}
