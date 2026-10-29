-- =========================================================
-- REQUIREMENT TOOL V2 — Node.js Backend Migration 015
-- Grants for: AssessmentRecord (Completeness, Quality, Readiness,
-- Impact Review — Phase 6 Quality & Completeness Core).
--
-- SCHEMA VERIFICATION (DDL read directly from Supabase Cloud via
-- pg_attribute/pg_constraint/pg_get_functiondef before writing this
-- migration - this table's creation migration is not present in this
-- repo's local migrations/ directory, same situation as migrations
-- 013/014):
--
--   assessment_records(assessment_id pk, case_id fk cases,
--     assessment_type NN check-enum[COMPLETENESS/QUALITY/READINESS/
--     IMPACT_REVIEW], manifest_id NN fk baseline_manifests,
--     policy_version_id NN fk definition_versions, validation_run_id
--     fk validation_runs (nullable), outcome NN, summary, result_details
--     jsonb, record_status NN check-enum[DRAFT/FINALIZED] default DRAFT,
--     assessed_at NN, assessed_by NN fk auth.users).
--   CHECK chk_assessment_type_outcome enforces a type-specific outcome
--   vocabulary (DB-level, not just a service whitelist):
--     READINESS    -> READY / READY_BUT_BLOCKED / NOT_READY
--     COMPLETENESS -> COMPLETE / INCOMPLETE / UNKNOWN
--     QUALITY      -> PASS / FAIL / UNKNOWN
--     IMPACT_REVIEW-> REVIEWED / REVIEW_REQUIRED / UNKNOWN
--   (IMPACT_REVIEW is out of scope for this batch - no code writes it;
--   left for a later batch per the approved plan, same posture as
--   issues/issue_resolutions in P2.)
--
-- Trigger behavior (read via pg_get_functiondef, governs write order
-- in src/modules/assessment/service.ts):
--   rt_protect_final_assessment — once record_status = 'FINALIZED',
--     ANY further UPDATE or DELETE raises an exception (same
--     "frozen means truly immutable" posture as baseline_manifests'
--     rt_guard_manifest_update). Transitioning TO 'FINALIZED' requires
--     the referenced manifest_id to belong to the SAME case_id AND be
--     manifest_status = 'FROZEN' at that moment - enforced by the DB
--     itself, not just application code. The service therefore always
--     creates a DRAFT assessment_records row against an ALREADY-FROZEN
--     manifest (reusing P2-D's createValidationRunService, which
--     freezes its own manifest before returning), then performs the
--     single UPDATE that finalizes it - never the reverse order.
--   rt_assessment_case_stable — case_id is immutable after creation
--     (BEFORE UPDATE OF case_id trigger), not relevant to this
--     module's code since no update ever touches case_id.
--   rt_assessment_manifest_case — case_id must equal the referenced
--     manifest's case_id on INSERT or UPDATE (same function already
--     used by validation_runs in migration 013) - the service always
--     derives case_id from the Case the manifest/run was created for,
--     never a second independent client input.
--
-- No table here carries a FK to entity_identities - an Assessment
-- Record is itself the kind of finalized, immutable event this schema
-- already has several of (baseline_manifests, validation_runs), not a
-- "registered, traceable, revisioned" business object, so no
-- registerEntity()/createRevision() calls appear in this batch's code.
--
-- Apply manually on Machine A, AFTER 001-014.
-- =========================================================

BEGIN;

-- ---------------------------------------------------------
-- 1. Grants.
--
--   assessment_records   SELECT, INSERT, UPDATE — create DRAFT, then
--                         the single UPDATE that finalizes it (outcome/
--                         summary/result_details/record_status).
--                         No DELETE — a finalized record is immutable
--                         by trigger anyway, and a draft with a mistake
--                         is simply abandoned, not removed (same
--                         posture as baseline_manifests).
-- ---------------------------------------------------------

GRANT SELECT, INSERT, UPDATE ON public.assessment_records TO app_backend;

-- ---------------------------------------------------------
-- 2. RLS — same per-operation app_backend-scoped pattern as every
-- prior migration.
-- ---------------------------------------------------------

DROP POLICY IF EXISTS rt_app_backend_select ON public.assessment_records;
CREATE POLICY rt_app_backend_select ON public.assessment_records
    FOR SELECT TO app_backend USING (true);
DROP POLICY IF EXISTS rt_app_backend_insert ON public.assessment_records;
CREATE POLICY rt_app_backend_insert ON public.assessment_records
    FOR INSERT TO app_backend WITH CHECK (true);
DROP POLICY IF EXISTS rt_app_backend_update ON public.assessment_records;
CREATE POLICY rt_app_backend_update ON public.assessment_records
    FOR UPDATE TO app_backend USING (true) WITH CHECK (true);

COMMIT;

-- ---------------------------------------------------------
-- Verification query (run after commit, read-only):
--
--   SELECT table_name, privilege_type
--   FROM information_schema.role_table_grants
--   WHERE grantee = 'app_backend' AND table_name = 'assessment_records'
--   ORDER BY privilege_type;
--   -- Expect: INSERT, SELECT, UPDATE. No DELETE.
-- ---------------------------------------------------------
