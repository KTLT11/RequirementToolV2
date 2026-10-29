-- =========================================================
-- REQUIREMENT TOOL V2 — Node.js Backend Migration 010
-- Grants for: Stakeholder & Evidence, part 2 (P3-FR-014)
-- Evidence, Evidence Review, Evidence Confirmation, Business
-- Decision.
--
-- Tables already exist, created together in
-- 20261022072200_create_evidence_specification_schema.sql, group D
-- "EVIDENCE AND ISSUES" (issues/issue_resolutions are NOT covered by
-- this migration - out of scope for this batch per the approved
-- plan).
--
-- SCHEMA VERIFICATION (full migration history read before writing
-- this file): evidence.evidence_id and business_decisions.decision_id
-- BOTH carry a FK to entity_identities, added by
-- 20261022074857_repair_entity_identity_foreign_keys.sql
-- (fk_evidence_identity, fk_business_decision_identity) - confirmed
-- present in that migration's 13-table list. evidence_review_records
-- and evidence_confirmation_records do NOT carry that FK (absent from
-- the same list), but DO carry a composite FK added by
-- 20261022080501_repair_schema_integrity.sql:
--   evidence_review_records(evidence_id, evidence_revision_id)
--     -> entity_revisions(entity_id, entity_revision_id)
--   evidence_confirmation_records(evidence_id, evidence_revision_id)
--     -> entity_revisions(entity_id, entity_revision_id)
-- This means evidence_revision_id in both tables must be a real,
-- existing entity_revisions row for that specific evidence_id - the
-- service code resolves "the current revision" by querying
-- entity_revisions directly (max revision_no for that entity_id),
-- never accepting evidence_revision_id from the client.
--
-- No trigger is attached to any of these 4 tables (checked all
-- CREATE TRIGGER statements across every migration).
--
-- Apply manually on Machine A, AFTER 001-009.
-- =========================================================

BEGIN;

-- ---------------------------------------------------------
-- 1. Grants.
--
--   evidence                      SELECT, INSERT, UPDATE — create and
--                                  revise Evidence (evidence_status /
--                                  review_status column updates,
--                                  current_revision_no bump). No
--                                  DELETE — superseded evidence is
--                                  marked, not removed.
--
--   evidence_review_records        SELECT, INSERT — a review event is
--                                   append-only (no column on this
--                                   table is ever updated after
--                                   creation).
--
--   evidence_confirmation_records  SELECT, INSERT — same reasoning,
--                                   append-only confirmation events.
--
--   business_decisions             SELECT, INSERT, UPDATE — same
--                                   pattern as evidence (decision
--                                   revised via current_revision_no).
-- ---------------------------------------------------------

GRANT SELECT, INSERT, UPDATE ON public.evidence TO app_backend;
GRANT SELECT, INSERT ON public.evidence_review_records TO app_backend;
GRANT SELECT, INSERT ON public.evidence_confirmation_records TO app_backend;
GRANT SELECT, INSERT, UPDATE ON public.business_decisions TO app_backend;

-- ---------------------------------------------------------
-- 2. RLS — same per-operation app_backend-scoped pattern as every
-- prior migration.
-- ---------------------------------------------------------

DROP POLICY IF EXISTS rt_app_backend_select ON public.evidence;
CREATE POLICY rt_app_backend_select ON public.evidence
    FOR SELECT TO app_backend USING (true);
DROP POLICY IF EXISTS rt_app_backend_insert ON public.evidence;
CREATE POLICY rt_app_backend_insert ON public.evidence
    FOR INSERT TO app_backend WITH CHECK (true);
DROP POLICY IF EXISTS rt_app_backend_update ON public.evidence;
CREATE POLICY rt_app_backend_update ON public.evidence
    FOR UPDATE TO app_backend USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS rt_app_backend_select ON public.evidence_review_records;
CREATE POLICY rt_app_backend_select ON public.evidence_review_records
    FOR SELECT TO app_backend USING (true);
DROP POLICY IF EXISTS rt_app_backend_insert ON public.evidence_review_records;
CREATE POLICY rt_app_backend_insert ON public.evidence_review_records
    FOR INSERT TO app_backend WITH CHECK (true);

DROP POLICY IF EXISTS rt_app_backend_select ON public.evidence_confirmation_records;
CREATE POLICY rt_app_backend_select ON public.evidence_confirmation_records
    FOR SELECT TO app_backend USING (true);
DROP POLICY IF EXISTS rt_app_backend_insert ON public.evidence_confirmation_records;
CREATE POLICY rt_app_backend_insert ON public.evidence_confirmation_records
    FOR INSERT TO app_backend WITH CHECK (true);

DROP POLICY IF EXISTS rt_app_backend_select ON public.business_decisions;
CREATE POLICY rt_app_backend_select ON public.business_decisions
    FOR SELECT TO app_backend USING (true);
DROP POLICY IF EXISTS rt_app_backend_insert ON public.business_decisions;
CREATE POLICY rt_app_backend_insert ON public.business_decisions
    FOR INSERT TO app_backend WITH CHECK (true);
DROP POLICY IF EXISTS rt_app_backend_update ON public.business_decisions;
CREATE POLICY rt_app_backend_update ON public.business_decisions
    FOR UPDATE TO app_backend USING (true) WITH CHECK (true);

COMMIT;

-- ---------------------------------------------------------
-- Verification query (run after commit, read-only):
--
--   SELECT table_name, privilege_type
--   FROM information_schema.role_table_grants
--   WHERE grantee = 'app_backend'
--     AND table_name IN ('evidence', 'evidence_review_records',
--                         'evidence_confirmation_records',
--                         'business_decisions')
--   ORDER BY table_name, privilege_type;
--   -- Expect: evidence/business_decisions -> INSERT, SELECT, UPDATE;
--   -- evidence_review_records/evidence_confirmation_records ->
--   -- INSERT, SELECT. No DELETE anywhere.
-- ---------------------------------------------------------
