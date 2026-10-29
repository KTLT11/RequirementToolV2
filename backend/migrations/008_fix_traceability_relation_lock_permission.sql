-- =========================================================
-- REQUIREMENT TOOL V2 — Node.js Backend Migration 008
-- Fix: app_backend needs UPDATE on traceability_relations for row
-- locking inside an existing trigger, discovered via a live
-- integration-test failure.
--
-- ROOT CAUSE: the existing trigger `rt_relation_revision_endpoint`
-- (function rt_check_relation_revision(), defined in
-- 20261022080939_enforce_business_integrity_core.sql, fires BEFORE
-- INSERT on relation_revisions) runs:
--
--   SELECT r.source_entity_id, r.target_entity_id
--   FROM public.traceability_relations r
--   WHERE r.relation_id = NEW.relation_id
--   FOR SHARE;
--
-- Under Postgres RLS, a row-locking SELECT (`FOR SHARE`/`FOR UPDATE`)
-- is checked against the UPDATE policy for that table, not just the
-- SELECT policy - this is standard Postgres RLS behavior (locking a
-- row is treated as a potential precursor to modifying it), not
-- specific to this schema. Migration 007 only granted
-- SELECT/INSERT on traceability_relations, so every call that goes
-- through this trigger (i.e. every Requirement Split, FR-018) failed
-- with "permission denied for table traceability_relations" the
-- first time it was exercised against live data (it cannot be caught
-- by unit tests, which never touch a real trigger).
--
-- FIX: grant UPDATE and add the matching per-operation RLS policy, so
-- the trigger's FOR SHARE can acquire its lock. The Node.js code
-- itself still never issues an UPDATE against traceability_relations
-- (see src/modules/traceability/repository.ts - no updateRelation
-- function exists) - this grant exists solely so the row-lock check
-- the trigger performs succeeds; it does not newly allow the backend
-- to silently rewrite existing relations through any code path that
-- exists today.
--
-- Apply manually on Machine A, AFTER 001-007. Written to be safely
-- re-runnable (DROP POLICY IF EXISTS before CREATE POLICY).
-- =========================================================

BEGIN;

GRANT UPDATE ON public.traceability_relations TO app_backend;

DROP POLICY IF EXISTS rt_app_backend_update ON public.traceability_relations;
CREATE POLICY rt_app_backend_update ON public.traceability_relations
    FOR UPDATE TO app_backend USING (true) WITH CHECK (true);

COMMIT;

-- ---------------------------------------------------------
-- Verification queries (run after commit, read-only):
--
--   SELECT grantee, privilege_type
--   FROM information_schema.role_table_grants
--   WHERE table_name = 'traceability_relations' AND grantee = 'app_backend'
--   ORDER BY privilege_type;
--   -- Expect: INSERT, SELECT, UPDATE. Still no DELETE.
--
--   -- Confirm the row-locking SELECT that previously failed now
--   -- succeeds (run as app_backend; replace the LIMIT 1 row - any
--   -- existing row, or none, is fine, this just confirms no
--   -- permission error):
--   SET ROLE app_backend;
--   SELECT source_entity_id, target_entity_id
--   FROM public.traceability_relations LIMIT 1 FOR SHARE;
--   RESET ROLE;
--   -- Expect: no error (0 or 1 row returned, not "permission denied").
-- ---------------------------------------------------------
