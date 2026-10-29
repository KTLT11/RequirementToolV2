-- =========================================================
-- REQUIREMENT TOOL V2 — Node.js Backend Migration 009
-- Grants for: Stakeholder & Evidence, part 1 (P3-FR-012/013)
-- Stakeholder, Case Role/Authority, Stakeholder Form/Response.
--
-- SCHEMA VERIFICATION (full migration history read in chronological
-- order, per the established practice): the 10 tables below were
-- CREATED TWICE. The original creation migrations
-- (20261022065449_create_stakeholder_authority_schema.sql,
-- 20261022065935_create_form_management_schema.sql) were entirely
-- superseded - a later migration
-- (20261022071002_repair_stakeholder_form_schema.sql) DROPs all 10
-- tables (guarded by a precheck that aborts if any contain data) and
-- CREATEs them again with a different, Data-Dictionary-aligned
-- shape. The repair migration's shape is what actually exists on
-- Supabase Cloud; this migration's grants/policies, and all the
-- repository code in this batch, are written against that shape -
-- NOT the two original creation migrations, which describe tables
-- that no longer exist.
--
-- None of these 10 tables carry a FK to entity_identities (grepped
-- the repair migration for "entity_identities" - zero matches, and
-- confirmed none of the 10 appear in the separate 13-table list in
-- 20261022074857_repair_entity_identity_foreign_keys.sql). No
-- registerEntity()/createRevision() calls anywhere in this batch's
-- code.
--
-- Trigger note: form_responses has a BEFORE INSERT/UPDATE trigger
-- (rt_check_form_response_case, from
-- 20261022080939_enforce_business_integrity_core.sql) that rejects
-- any row whose case_id does not match the owning form's case_id
-- (traced through form_versions -> stakeholder_forms). The service
-- code always derives case_id server-side from the form, never from
-- client input, so this trigger should never actually fire a
-- rejection in normal operation - it exists as a second line of
-- defense, not as something the application is expected to trip.
--
-- Tables: stakeholders, case_stakeholders, role_assignments,
-- authority_assignments, stakeholder_forms, form_versions,
-- form_question_items, public_access_grants, form_responses,
-- form_answers.
--
-- Apply manually on Machine A, AFTER 001-008. Written to be safely
-- re-runnable (DROP POLICY IF EXISTS before every CREATE POLICY).
-- =========================================================

BEGIN;

-- ---------------------------------------------------------
-- 1. Grants — no DELETE anywhere, matching the "no hard delete"
-- posture used throughout. Lifecycle changes (participation ended,
-- form closed, grant revoked, response reviewed) are all column
-- updates (ended_at, status, revoked_at, review_status), never row
-- deletion.
-- ---------------------------------------------------------

GRANT SELECT, INSERT, UPDATE ON public.stakeholders TO app_backend;
GRANT SELECT, INSERT, UPDATE ON public.case_stakeholders TO app_backend;
GRANT SELECT, INSERT, UPDATE ON public.role_assignments TO app_backend;
GRANT SELECT, INSERT, UPDATE ON public.authority_assignments TO app_backend;
GRANT SELECT, INSERT, UPDATE ON public.stakeholder_forms TO app_backend;
GRANT SELECT, INSERT, UPDATE ON public.form_versions TO app_backend;
GRANT SELECT, INSERT ON public.form_question_items TO app_backend;
GRANT SELECT, INSERT, UPDATE ON public.public_access_grants TO app_backend;
GRANT SELECT, INSERT, UPDATE ON public.form_responses TO app_backend;
GRANT SELECT, INSERT, UPDATE ON public.form_answers TO app_backend;

-- ---------------------------------------------------------
-- 2. RLS — same per-operation app_backend-scoped pattern as every
-- prior migration. These 10 tables already have RLS ENABLED (from
-- the repair migration itself) with ALL privileges revoked from
-- anon/authenticated (no existing rt_ba_read-style policy to
-- preserve here, unlike the 50-table group migration 13 covered -
-- these 10 tables were recreated after that migration ran, so they
-- never got that policy).
--
-- IMPORTANT: app_backend must be able to reach these tables for BOTH
-- authenticated BA routes (/api/cases/:id/stakeholders, etc.) AND the
-- unauthenticated public submission routes
-- (/api/public/forms/:token/responses). Both paths use the same
-- app_backend DB role - the distinction between "BA must be logged
-- in" and "anyone with a valid token can submit" is enforced entirely
-- in the Express route layer (whether authenticate()/requireRole('BA')
-- middleware is attached to that router), not by a different DB role
-- or a different RLS policy. These policies are therefore permissive
-- for app_backend on purpose, same as every other table so far - this
-- is not a new or weaker posture introduced for the public path.
-- ---------------------------------------------------------

DROP POLICY IF EXISTS rt_app_backend_select ON public.stakeholders;
CREATE POLICY rt_app_backend_select ON public.stakeholders
    FOR SELECT TO app_backend USING (true);
DROP POLICY IF EXISTS rt_app_backend_insert ON public.stakeholders;
CREATE POLICY rt_app_backend_insert ON public.stakeholders
    FOR INSERT TO app_backend WITH CHECK (true);
DROP POLICY IF EXISTS rt_app_backend_update ON public.stakeholders;
CREATE POLICY rt_app_backend_update ON public.stakeholders
    FOR UPDATE TO app_backend USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS rt_app_backend_select ON public.case_stakeholders;
CREATE POLICY rt_app_backend_select ON public.case_stakeholders
    FOR SELECT TO app_backend USING (true);
DROP POLICY IF EXISTS rt_app_backend_insert ON public.case_stakeholders;
CREATE POLICY rt_app_backend_insert ON public.case_stakeholders
    FOR INSERT TO app_backend WITH CHECK (true);
DROP POLICY IF EXISTS rt_app_backend_update ON public.case_stakeholders;
CREATE POLICY rt_app_backend_update ON public.case_stakeholders
    FOR UPDATE TO app_backend USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS rt_app_backend_select ON public.role_assignments;
CREATE POLICY rt_app_backend_select ON public.role_assignments
    FOR SELECT TO app_backend USING (true);
DROP POLICY IF EXISTS rt_app_backend_insert ON public.role_assignments;
CREATE POLICY rt_app_backend_insert ON public.role_assignments
    FOR INSERT TO app_backend WITH CHECK (true);
DROP POLICY IF EXISTS rt_app_backend_update ON public.role_assignments;
CREATE POLICY rt_app_backend_update ON public.role_assignments
    FOR UPDATE TO app_backend USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS rt_app_backend_select ON public.authority_assignments;
CREATE POLICY rt_app_backend_select ON public.authority_assignments
    FOR SELECT TO app_backend USING (true);
DROP POLICY IF EXISTS rt_app_backend_insert ON public.authority_assignments;
CREATE POLICY rt_app_backend_insert ON public.authority_assignments
    FOR INSERT TO app_backend WITH CHECK (true);
DROP POLICY IF EXISTS rt_app_backend_update ON public.authority_assignments;
CREATE POLICY rt_app_backend_update ON public.authority_assignments
    FOR UPDATE TO app_backend USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS rt_app_backend_select ON public.stakeholder_forms;
CREATE POLICY rt_app_backend_select ON public.stakeholder_forms
    FOR SELECT TO app_backend USING (true);
DROP POLICY IF EXISTS rt_app_backend_insert ON public.stakeholder_forms;
CREATE POLICY rt_app_backend_insert ON public.stakeholder_forms
    FOR INSERT TO app_backend WITH CHECK (true);
DROP POLICY IF EXISTS rt_app_backend_update ON public.stakeholder_forms;
CREATE POLICY rt_app_backend_update ON public.stakeholder_forms
    FOR UPDATE TO app_backend USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS rt_app_backend_select ON public.form_versions;
CREATE POLICY rt_app_backend_select ON public.form_versions
    FOR SELECT TO app_backend USING (true);
DROP POLICY IF EXISTS rt_app_backend_insert ON public.form_versions;
CREATE POLICY rt_app_backend_insert ON public.form_versions
    FOR INSERT TO app_backend WITH CHECK (true);
DROP POLICY IF EXISTS rt_app_backend_update ON public.form_versions;
CREATE POLICY rt_app_backend_update ON public.form_versions
    FOR UPDATE TO app_backend USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS rt_app_backend_select ON public.form_question_items;
CREATE POLICY rt_app_backend_select ON public.form_question_items
    FOR SELECT TO app_backend USING (true);
DROP POLICY IF EXISTS rt_app_backend_insert ON public.form_question_items;
CREATE POLICY rt_app_backend_insert ON public.form_question_items
    FOR INSERT TO app_backend WITH CHECK (true);

DROP POLICY IF EXISTS rt_app_backend_select ON public.public_access_grants;
CREATE POLICY rt_app_backend_select ON public.public_access_grants
    FOR SELECT TO app_backend USING (true);
DROP POLICY IF EXISTS rt_app_backend_insert ON public.public_access_grants;
CREATE POLICY rt_app_backend_insert ON public.public_access_grants
    FOR INSERT TO app_backend WITH CHECK (true);
DROP POLICY IF EXISTS rt_app_backend_update ON public.public_access_grants;
CREATE POLICY rt_app_backend_update ON public.public_access_grants
    FOR UPDATE TO app_backend USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS rt_app_backend_select ON public.form_responses;
CREATE POLICY rt_app_backend_select ON public.form_responses
    FOR SELECT TO app_backend USING (true);
DROP POLICY IF EXISTS rt_app_backend_insert ON public.form_responses;
CREATE POLICY rt_app_backend_insert ON public.form_responses
    FOR INSERT TO app_backend WITH CHECK (true);
DROP POLICY IF EXISTS rt_app_backend_update ON public.form_responses;
CREATE POLICY rt_app_backend_update ON public.form_responses
    FOR UPDATE TO app_backend USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS rt_app_backend_select ON public.form_answers;
CREATE POLICY rt_app_backend_select ON public.form_answers
    FOR SELECT TO app_backend USING (true);
DROP POLICY IF EXISTS rt_app_backend_insert ON public.form_answers;
CREATE POLICY rt_app_backend_insert ON public.form_answers
    FOR INSERT TO app_backend WITH CHECK (true);
DROP POLICY IF EXISTS rt_app_backend_update ON public.form_answers;
CREATE POLICY rt_app_backend_update ON public.form_answers
    FOR UPDATE TO app_backend USING (true) WITH CHECK (true);

COMMIT;

-- ---------------------------------------------------------
-- Verification query (run after commit, read-only):
--
--   SELECT table_name, privilege_type
--   FROM information_schema.role_table_grants
--   WHERE grantee = 'app_backend'
--     AND table_name IN ('stakeholders', 'case_stakeholders',
--                         'role_assignments', 'authority_assignments',
--                         'stakeholder_forms', 'form_versions',
--                         'form_question_items', 'public_access_grants',
--                         'form_responses', 'form_answers')
--   ORDER BY table_name, privilege_type;
--   -- Expect INSERT/SELECT/UPDATE on all except form_question_items
--   -- (INSERT/SELECT only - question items are frozen with their
--   -- form version, never edited after creation). No DELETE anywhere.
-- ---------------------------------------------------------
