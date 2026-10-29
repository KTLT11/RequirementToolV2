-- =========================================================
-- REQUIREMENT TOOL V2 — Node.js Backend Migration 018
-- Grants for: Document, DocumentSnapshot, DocumentPublication,
-- CustomerConfirmation, ConfirmationScopeItem, HandoffBaseline,
-- DevReviewRecord (Phase 6 — P3 Confirmation, Document, Publication,
-- Development Handoff).
--
-- SCHEMA VERIFICATION (DDL read directly from Supabase Cloud via
-- pg_attribute/pg_constraint/pg_get_functiondef before writing this
-- migration - this group's creation migration is not present in this
-- repo's local migrations/ directory, same situation as every other
-- "group not yet touched" batch so far):
--
--   documents(document_id pk, case_id fk cases, document_type NN
--     check-enum[CRD/DRD], document_name NN non-empty, document_status
--     NN check-enum[WORKING/ACTIVE/ARCHIVED] default WORKING, created_at
--     NN default now(), created_by NN fk auth.users).
--
--   document_snapshots(snapshot_id pk, document_id NN fk documents,
--     manifest_id NN fk baseline_manifests, snapshot_version NN >=1,
--     storage_object_path NN, content_sha256 NN char(64) hex, content_
--     mime_type NN, rendered_at NN, rendered_by NN fk auth.users,
--     render_status NN check-enum[FROZEN/INVALIDATED]).
--     UNIQUE(document_id, snapshot_version), UNIQUE(document_id,
--     snapshot_id), UNIQUE(snapshot_id, manifest_id) [composite FK
--     targets].
--
--   document_publications(publication_id pk, document_id NN fk
--     documents, snapshot_id NN, publication_version NN >=1,
--     publication_purpose NN check-enum[CUSTOMER_REVIEW/DEV_REVIEW/
--     HANDOFF], recipient_scope NN, publication_status NN check-enum
--     [PUBLISHED/WITHDRAWN/SUPERSEDED], published_at NN, published_by
--     NN fk auth.users, transmission_reference).
--     Composite FK (document_id, snapshot_id) -> document_snapshots
--     (document_id, snapshot_id) [ensures snapshot belongs to the same
--     document]. UNIQUE(document_id, publication_version), UNIQUE
--     (publication_id, snapshot_id) [composite FK target for
--     customer_confirmations].
--
--   customer_confirmations(confirmation_id pk, publication_id NN,
--     snapshot_id NN, manifest_id NN, signer_stakeholder_id NN fk
--     stakeholders, signer_authority_id fk authority_assignments
--     (nullable in schema, but the trigger makes it effectively
--     required), confirmation_outcome NN check-enum[CONFIRMED/PARTIAL/
--     CHANGES_REQUESTED/REJECTED], confirmation_basis NN non-empty,
--     comments, occurred_at NN, recorded_at NN default now(),
--     recorded_by NN fk auth.users).
--     Composite FK (publication_id, snapshot_id) -> document_
--     publications(publication_id, snapshot_id); composite FK
--     (snapshot_id, manifest_id) -> document_snapshots(snapshot_id,
--     manifest_id). UNIQUE(confirmation_id, manifest_id) [composite FK
--     target for confirmation_scope_items].
--
--   confirmation_scope_items(confirmation_scope_item_id pk,
--     confirmation_id NN, manifest_id NN, manifest_item_id NN,
--     unit_outcome NN check-enum[CONFIRMED/NOT_CONFIRMED/CHANGES_
--     REQUESTED], note). Composite FK (manifest_id, manifest_item_id)
--     -> manifest_items(manifest_id, manifest_item_id); composite FK
--     (confirmation_id, manifest_id) -> customer_confirmations
--     (confirmation_id, manifest_id). UNIQUE(confirmation_id,
--     manifest_item_id).
--
--   handoff_baselines(handoff_id pk, case_id NN fk cases, readiness_
--     assessment_id NN fk assessment_records, manifest_id NN fk
--     baseline_manifests, handoff_purpose NN check-enum[DEV_
--     IMPLEMENTATION/DEV_REVIEW], baseline_status NN check-enum
--     [ISSUED/WITHDRAWN/SUPERSEDED], issued_at NN, issued_by NN fk
--     auth.users).
--
--   dev_review_records(dev_review_id pk, handoff_id NN fk handoff_
--     baselines, reviewer_stakeholder_id NN fk stakeholders, review_
--     outcome NN check-enum[PENDING/ACCEPTED/ACCEPTED_WITH_BLOCKERS/
--     CHANGES_REQUESTED], review_comments, review_evidence_ref,
--     reviewed_at [NULL iff review_outcome='PENDING', per CHECK],
--     recorded_at NN default now(), recorded_by NN fk auth.users).
--
-- Trigger behavior (read via pg_get_functiondef, governs write order
-- in src/modules/documents, src/modules/confirmations, src/modules/
-- handoff — see each module's own comment for how it specifically
-- honors these):
--   rt_document_case_stable      — case_id immutable after creation
--                                   (BEFORE UPDATE OF case_id).
--   rt_snapshot_manifest_state   — a document_snapshots INSERT
--                                   requires its manifest to ALREADY be
--                                   manifest_status='FROZEN' AND
--                                   manifest_purpose='DOCUMENT' at that
--                                   moment - the service always freezes
--                                   its own purpose-DOCUMENT manifest
--                                   BEFORE inserting the snapshot, never
--                                   the reverse order.
--   rt_check_snapshot_case       — the snapshot's document and manifest
--                                   must belong to the same case_id.
--   rt_protect_document_snapshot — once inserted, EVERY column except
--                                   render_status is permanently
--                                   immutable; the only allowed UPDATE
--                                   is render_status FROZEN->INVALIDATED
--                                   (no INSERT creates it pre-invalidated
--                                   - INSERT must always set FROZEN).
--                                   DELETE is always rejected.
--   rt_guard_document_publication — INSERT requires snapshot AND its
--                                   manifest to both already be FROZEN,
--                                   and must insert with publication_
--                                   status='PUBLISHED' (never any other
--                                   starting value). UPDATE may only
--                                   change publication_status, and only
--                                   PUBLISHED->WITHDRAWN or PUBLISHED->
--                                   SUPERSEDED - every other column is
--                                   immutable. DELETE always rejected.
--   rt_guard_customer_confirmation — INSERT only (UPDATE/DELETE always
--                                   rejected - "history is immutable").
--                                   Requires: the cited publication is
--                                   document_type='CRD',
--                                   publication_purpose='CUSTOMER_REVIEW',
--                                   publication_status='PUBLISHED', its
--                                   snapshot render_status='FROZEN'; the
--                                   cited manifest_id is FROZEN and
--                                   belongs to the same case_id as the
--                                   document; occurred_at >= the
--                                   publication's published_at;
--                                   signer_authority_id is NOT NULL and
--                                   resolves to an authority_assignments
--                                   row with verification_status=
--                                   'VERIFIED', permitted_action=
--                                   'CONFIRM', valid_from <= occurred_at
--                                   < valid_to (or valid_to IS NULL);
--                                   AND that authority's case_stakeholder
--                                   must match signer_stakeholder_id AND
--                                   have joined_at <= occurred_at <
--                                   ended_at (or ended_at IS NULL) for
--                                   the SAME case as the document. This
--                                   is the strictest trigger in the
--                                   schema so far - the service
--                                   pre-validates the same conditions
--                                   itself (clearer error messages),
--                                   but never removes or weakens this
--                                   trigger as the final authority.
--   rt_guard_confirmation_scope  — INSERT only. Requires the cited
--                                   manifest_item to be item_kind=
--                                   'ENTITY_REVISION', membership_role=
--                                   'CONFIRMABLE', and its manifest to
--                                   be FROZEN.
--   rt_guard_handoff              — INSERT requires: the cited
--                                   readiness_assessment_id resolves to
--                                   an assessment_records row with the
--                                   SAME case_id, assessment_type=
--                                   'READINESS', record_status=
--                                   'FINALIZED', outcome IN ('READY',
--                                   'READY_BUT_BLOCKED'); the cited
--                                   manifest_id is the SAME case_id,
--                                   manifest_purpose='HANDOFF', and
--                                   FROZEN; issued_at >= the
--                                   assessment's assessed_at; and must
--                                   insert with baseline_status='ISSUED'.
--                                   UPDATE may only change baseline_
--                                   status, and only ISSUED->WITHDRAWN
--                                   or ISSUED->SUPERSEDED. DELETE always
--                                   rejected.
--   rt_guard_dev_review           — DELETE always rejected. UPDATE is
--                                   only allowed while OLD.review_
--                                   outcome='PENDING' (a completed
--                                   review is immutable), and even then
--                                   may not change handoff_id/reviewer_
--                                   stakeholder_id/recorded_at/recorded_
--                                   by. INSERT/UPDATE both require
--                                   reviewer_stakeholder_id to belong to
--                                   a case_stakeholders row for the
--                                   handoff's own case_id.
--
-- No table here carries a FK to entity_identities - these are all
-- immutable event/snapshot records (same posture as baseline_manifests,
-- validation_runs, assessment_records), not revisioned business
-- objects, so no registerEntity()/createRevision() calls appear in
-- this batch's code.
--
-- Apply manually on Machine A, AFTER 001-017.
-- =========================================================

BEGIN;

-- ---------------------------------------------------------
-- 1. Grants.
--
--   documents                  SELECT, INSERT, UPDATE (document_status
--                               WORKING/ACTIVE/ARCHIVED transitions).
--                               No DELETE.
--   document_snapshots         SELECT, INSERT, UPDATE (render_status
--                               FROZEN->INVALIDATED only - enforced by
--                               trigger, not by withholding the grant,
--                               since content columns need no UPDATE
--                               path but render_status does). No DELETE.
--   document_publications      SELECT, INSERT, UPDATE (publication_
--                               status transitions). No DELETE.
--   customer_confirmations     SELECT, INSERT only - append-only event,
--                               trigger rejects UPDATE/DELETE outright
--                               so granting them would be misleading.
--   confirmation_scope_items   SELECT, INSERT only - same reasoning.
--   handoff_baselines          SELECT, INSERT, UPDATE (baseline_status
--                               transitions). No DELETE.
--   dev_review_records         SELECT, INSERT, UPDATE (PENDING -> a
--                               terminal outcome, per the trigger's own
--                               allowance). No DELETE - trigger rejects
--                               it outright.
-- ---------------------------------------------------------

GRANT SELECT, INSERT, UPDATE ON public.documents TO app_backend;
GRANT SELECT, INSERT, UPDATE ON public.document_snapshots TO app_backend;
GRANT SELECT, INSERT, UPDATE ON public.document_publications TO app_backend;
GRANT SELECT, INSERT ON public.customer_confirmations TO app_backend;
GRANT SELECT, INSERT ON public.confirmation_scope_items TO app_backend;
GRANT SELECT, INSERT, UPDATE ON public.handoff_baselines TO app_backend;
GRANT SELECT, INSERT, UPDATE ON public.dev_review_records TO app_backend;

-- ---------------------------------------------------------
-- 2. RLS — same per-operation app_backend-scoped pattern as every
-- prior migration.
-- ---------------------------------------------------------

DROP POLICY IF EXISTS rt_app_backend_select ON public.documents;
CREATE POLICY rt_app_backend_select ON public.documents
    FOR SELECT TO app_backend USING (true);
DROP POLICY IF EXISTS rt_app_backend_insert ON public.documents;
CREATE POLICY rt_app_backend_insert ON public.documents
    FOR INSERT TO app_backend WITH CHECK (true);
DROP POLICY IF EXISTS rt_app_backend_update ON public.documents;
CREATE POLICY rt_app_backend_update ON public.documents
    FOR UPDATE TO app_backend USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS rt_app_backend_select ON public.document_snapshots;
CREATE POLICY rt_app_backend_select ON public.document_snapshots
    FOR SELECT TO app_backend USING (true);
DROP POLICY IF EXISTS rt_app_backend_insert ON public.document_snapshots;
CREATE POLICY rt_app_backend_insert ON public.document_snapshots
    FOR INSERT TO app_backend WITH CHECK (true);
DROP POLICY IF EXISTS rt_app_backend_update ON public.document_snapshots;
CREATE POLICY rt_app_backend_update ON public.document_snapshots
    FOR UPDATE TO app_backend USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS rt_app_backend_select ON public.document_publications;
CREATE POLICY rt_app_backend_select ON public.document_publications
    FOR SELECT TO app_backend USING (true);
DROP POLICY IF EXISTS rt_app_backend_insert ON public.document_publications;
CREATE POLICY rt_app_backend_insert ON public.document_publications
    FOR INSERT TO app_backend WITH CHECK (true);
DROP POLICY IF EXISTS rt_app_backend_update ON public.document_publications;
CREATE POLICY rt_app_backend_update ON public.document_publications
    FOR UPDATE TO app_backend USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS rt_app_backend_select ON public.customer_confirmations;
CREATE POLICY rt_app_backend_select ON public.customer_confirmations
    FOR SELECT TO app_backend USING (true);
DROP POLICY IF EXISTS rt_app_backend_insert ON public.customer_confirmations;
CREATE POLICY rt_app_backend_insert ON public.customer_confirmations
    FOR INSERT TO app_backend WITH CHECK (true);

DROP POLICY IF EXISTS rt_app_backend_select ON public.confirmation_scope_items;
CREATE POLICY rt_app_backend_select ON public.confirmation_scope_items
    FOR SELECT TO app_backend USING (true);
DROP POLICY IF EXISTS rt_app_backend_insert ON public.confirmation_scope_items;
CREATE POLICY rt_app_backend_insert ON public.confirmation_scope_items
    FOR INSERT TO app_backend WITH CHECK (true);

DROP POLICY IF EXISTS rt_app_backend_select ON public.handoff_baselines;
CREATE POLICY rt_app_backend_select ON public.handoff_baselines
    FOR SELECT TO app_backend USING (true);
DROP POLICY IF EXISTS rt_app_backend_insert ON public.handoff_baselines;
CREATE POLICY rt_app_backend_insert ON public.handoff_baselines
    FOR INSERT TO app_backend WITH CHECK (true);
DROP POLICY IF EXISTS rt_app_backend_update ON public.handoff_baselines;
CREATE POLICY rt_app_backend_update ON public.handoff_baselines
    FOR UPDATE TO app_backend USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS rt_app_backend_select ON public.dev_review_records;
CREATE POLICY rt_app_backend_select ON public.dev_review_records
    FOR SELECT TO app_backend USING (true);
DROP POLICY IF EXISTS rt_app_backend_insert ON public.dev_review_records;
CREATE POLICY rt_app_backend_insert ON public.dev_review_records
    FOR INSERT TO app_backend WITH CHECK (true);
DROP POLICY IF EXISTS rt_app_backend_update ON public.dev_review_records;
CREATE POLICY rt_app_backend_update ON public.dev_review_records
    FOR UPDATE TO app_backend USING (true) WITH CHECK (true);

COMMIT;

-- ---------------------------------------------------------
-- Verification query (run after commit, read-only):
--
--   SELECT table_name, privilege_type
--   FROM information_schema.role_table_grants
--   WHERE grantee = 'app_backend'
--     AND table_name IN ('documents', 'document_snapshots',
--                         'document_publications', 'customer_confirmations',
--                         'confirmation_scope_items', 'handoff_baselines',
--                         'dev_review_records')
--   ORDER BY table_name, privilege_type;
--   -- Expect: documents/document_snapshots/document_publications/
--   -- handoff_baselines/dev_review_records -> INSERT, SELECT, UPDATE;
--   -- customer_confirmations/confirmation_scope_items -> INSERT, SELECT.
--   -- No DELETE anywhere.
-- ---------------------------------------------------------
