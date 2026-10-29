-- =========================================================
-- REQUIREMENT TOOL V2 — Node.js Backend Migration 012
-- Fix: add SELECT grant on entity_identities (P2-C regression).
--
-- Root cause: migration 005 deliberately granted app_backend only
-- INSERT on entity_identities, since at that time no module read the
-- table directly (its own comment said so explicitly: "No SELECT
-- needed yet ... add SELECT in a later migration if a future module
-- needs to query it directly"). The generic Traceability API written
-- for P2-C (src/modules/traceability/repository.ts, findEntityType())
-- is exactly that future module - it must look up entity_type by
-- entity_id to validate a relation's source/target against the
-- RELATION_TYPE's declared roles. Caught by a live integration test
-- failure ("permission denied for table entity_identities"), not by
-- static analysis - same category as the migration 006/008 fixes.
--
-- Apply manually on Machine A, AFTER 001-011.
-- =========================================================

BEGIN;

GRANT SELECT ON public.entity_identities TO app_backend;

DROP POLICY IF EXISTS rt_app_backend_select ON public.entity_identities;
CREATE POLICY rt_app_backend_select ON public.entity_identities
    FOR SELECT TO app_backend USING (true);

COMMIT;

-- ---------------------------------------------------------
-- Verification query (run after commit, read-only):
--
--   SELECT table_name, privilege_type
--   FROM information_schema.role_table_grants
--   WHERE grantee = 'app_backend' AND table_name = 'entity_identities'
--   ORDER BY privilege_type;
--   -- Expect: INSERT, SELECT. Still no UPDATE/DELETE.
-- ---------------------------------------------------------
