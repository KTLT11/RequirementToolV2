-- =========================================================
-- REQUIREMENT TOOL V2 — Node.js Backend Migration 003
-- Database role for Node.js: app_backend
--
-- Purpose: a dedicated, minimum-privilege Postgres role for the
-- Node.js backend's connection pool. Not a superuser, not
-- BYPASSRLS, not service_role. Authorization logic itself lives
-- in Node.js (see Phase 3) — this role only gates WHICH tables
-- and WHICH operations are reachable at the database layer at all.
--
-- Scope: additive only. Does not touch Supabase Auth, Edge
-- Functions, the existing `authenticated`/`anon`/`service_role`
-- grants, or rt_create_case_with_request / rt_update_case.
--
-- Apply manually on Machine A, AFTER 001 and 002.
-- =========================================================

BEGIN;

-- ---------------------------------------------------------
-- 1. Role
-- ---------------------------------------------------------
-- Replace the password placeholder before running. Use a long,
-- random value generated on Machine A; do not reuse any Supabase
-- credential. Store it only in the backend's server-side secrets
-- (e.g. environment variable), never in source control.

CREATE ROLE app_backend
    LOGIN
    PASSWORD '<SET_ON_MACHINE_A_DO_NOT_COMMIT>'
    NOSUPERUSER
    NOCREATEDB
    NOCREATEROLE
    NOBYPASSRLS;

-- ---------------------------------------------------------
-- 2. Schema usage
-- ---------------------------------------------------------
-- A role with table-level GRANTs still cannot resolve `public.<table>`
-- without USAGE on the schema itself (CREATE ROLE grants no schema
-- access by default on Supabase Cloud, since `public` is not owned by
-- the new role and PUBLIC's default USAGE was revoked when the
-- project was provisioned). Required for every query below to work
-- at all - this is schema-level, not a widening of table access.

GRANT USAGE ON SCHEMA public TO app_backend;

-- ---------------------------------------------------------
-- 3. Sequences / identity columns
-- ---------------------------------------------------------
-- Checked every one of the 14 migrations (grep for IDENTITY, SERIAL,
-- nextval, CREATE SEQUENCE): no table in the schema - including all
-- 6 tables below - uses a sequence or GENERATED ... AS IDENTITY
-- column. Every primary key is `uuid PRIMARY KEY DEFAULT
-- gen_random_uuid()`, a built-in function call, not a sequence
-- object. There is therefore nothing to grant USAGE ON SEQUENCE for;
-- this section intentionally grants none, rather than granting ALL
-- SEQUENCES defensively.

-- ---------------------------------------------------------
-- 4. Table grants — exactly the operations the current Case API
-- uses. Verified against supabase/functions/cases/index.ts:
--
--   cases                       SELECT (List, Get), INSERT (Create),
--                                UPDATE (Update Case: case_name only)
--   incoming_requests           SELECT (Get), INSERT (Create)
--   case_request_associations   SELECT (Get), INSERT (Create)
--   requirements                SELECT only (Get, summary fields) —
--                                no Case API path writes requirements
--   audit_events                INSERT only — no Case API path reads
--                                audit_events
--   app_users                   SELECT only — Node.js reads rt_role to
--                                authorize; app_users rows are written
--                                by the Phase 1 seed process, not by
--                                the running backend
--
-- No DELETE anywhere (matches the immutability triggers already in
-- place on revision/manifest tables and the general "no hard delete"
-- posture of the schema). No grants on any of the other 44 business
-- tables — out of scope until a later module needs them.
-- ---------------------------------------------------------

GRANT SELECT, INSERT, UPDATE ON public.cases TO app_backend;
GRANT SELECT, INSERT ON public.incoming_requests TO app_backend;
GRANT SELECT, INSERT ON public.case_request_associations TO app_backend;
GRANT SELECT ON public.requirements TO app_backend;
GRANT INSERT ON public.audit_events TO app_backend;
GRANT SELECT ON public.app_users TO app_backend;

-- ---------------------------------------------------------
-- 5. Triggers on the 6 tables above — checked whether Create/Update
-- Case would fire anything that needs privileges beyond the GRANTs
-- above.
--
-- Searched both trigger migrations (020...080939_enforce_business_
-- integrity_core.sql and ...081650_enforce_publication_confirmation_
-- handoff.sql) for every CREATE TRIGGER and its target table. None of
-- the ~20 triggers defined anywhere in the schema are attached to
-- `cases`, `incoming_requests`, `case_request_associations`,
-- `requirements`, or `audit_events` — they all target `manifest_items`,
-- `baseline_manifests`, `entity_revisions`, `relation_revisions`,
-- `document_snapshots`, `document_publications`, `customer_
-- confirmations`, `confirmation_scope_items`, `handoff_baselines`,
-- `dev_review_records`, `form_responses`, `form_versions`,
-- `traceability_relations`, `validation_runs`, `assessment_records`,
-- `documents`, `stakeholder_forms` — all outside the 6-table scope of
-- this role. Create/Update Case therefore fires no trigger at all, so
-- no SECURITY DEFINER function, no additional table read inside a
-- trigger body, and no additional grant is needed for this phase.
-- ---------------------------------------------------------

-- ---------------------------------------------------------
-- 6. RLS — tables already have ENABLE ROW LEVEL SECURITY from prior
-- migrations (cases, incoming_requests, case_request_associations,
-- requirements, audit_events). app_users is new and RLS is enabled
-- on it explicitly below. In both cases, RLS stays ENABLED (not
-- disabled) so it can be tightened later without a two-step
-- enable+policy change.
--
-- Policies below are scoped per-operation to mirror the GRANTs in
-- section 4 exactly (FOR SELECT / FOR INSERT / FOR UPDATE), not a
-- single `FOR ALL`. This keeps the RLS layer legible against what was
-- actually granted: a table with no UPDATE grant also gets no UPDATE
-- policy, so the two layers cannot drift apart silently (e.g. a later
-- `GRANT UPDATE` on `requirements` would still be blocked at the RLS
-- layer until a matching policy is added, instead of silently working
-- because a prior `FOR ALL` policy already covered it).
--
-- Each policy is permissive (`USING (true)` / `WITH CHECK (true)`)
-- for the single-role MVP — authorization is enforced in Node.js, not
-- per-row in Postgres, per the approved design. No policy is created
-- for any role other than app_backend. The existing `rt_ba_read`
-- policy (authenticated, auth.jwt()-based) is left untouched — it
-- still governs Supabase-Auth-based access until that path is retired
-- in a later phase.
-- ---------------------------------------------------------

ALTER TABLE public.app_users ENABLE ROW LEVEL SECURITY;

CREATE POLICY rt_app_backend_select ON public.cases
    FOR SELECT TO app_backend USING (true);
CREATE POLICY rt_app_backend_insert ON public.cases
    FOR INSERT TO app_backend WITH CHECK (true);
CREATE POLICY rt_app_backend_update ON public.cases
    FOR UPDATE TO app_backend USING (true) WITH CHECK (true);

CREATE POLICY rt_app_backend_select ON public.incoming_requests
    FOR SELECT TO app_backend USING (true);
CREATE POLICY rt_app_backend_insert ON public.incoming_requests
    FOR INSERT TO app_backend WITH CHECK (true);

CREATE POLICY rt_app_backend_select ON public.case_request_associations
    FOR SELECT TO app_backend USING (true);
CREATE POLICY rt_app_backend_insert ON public.case_request_associations
    FOR INSERT TO app_backend WITH CHECK (true);

CREATE POLICY rt_app_backend_select ON public.requirements
    FOR SELECT TO app_backend USING (true);

CREATE POLICY rt_app_backend_insert ON public.audit_events
    FOR INSERT TO app_backend WITH CHECK (true);

CREATE POLICY rt_app_backend_select ON public.app_users
    FOR SELECT TO app_backend USING (true);

COMMIT;

-- ---------------------------------------------------------
-- Verification queries (run after commit, read-only, all expected to
-- succeed / confirm the intended state — no denial tests here; those
-- live in backend/scripts/check-db-access.ts so a failed check-access
-- assertion never gets mistaken for a broken migration):
--
--   -- Confirm table grants match exactly what was requested:
--   SELECT table_name, privilege_type
--   FROM information_schema.role_table_grants
--   WHERE grantee = 'app_backend'
--   ORDER BY table_name, privilege_type;
--   -- Expect exactly the 6 tables from section 4, matching privileges,
--   -- and no 'DELETE' anywhere.
--
--   -- Confirm schema usage was actually granted:
--   SELECT has_schema_privilege('app_backend', 'public', 'USAGE');
--   -- Expect true.
--
--   -- Confirm app_backend has no elevated membership (not a member of
--   -- any role that would grant it broader effective privileges, e.g.
--   -- service_role, postgres, or any BYPASSRLS role):
--   SELECT r.rolname, r.rolsuper, r.rolbypassrls
--   FROM pg_auth_members m
--   JOIN pg_roles r ON r.oid = m.roleid
--   JOIN pg_roles m2 ON m2.oid = m.member
--   WHERE m2.rolname = 'app_backend';
--   -- Expect zero rows. If any row appears, app_backend's effective
--   -- privileges include whatever that parent role has — re-check
--   -- against NOSUPERUSER/NOBYPASSRLS before trusting the grants above.
--
--   -- Confirm app_backend's own role attributes are as intended:
--   SELECT rolname, rolsuper, rolcreatedb, rolcreaterole, rolbypassrls
--   FROM pg_roles WHERE rolname = 'app_backend';
--   -- Expect rolsuper/rolcreatedb/rolcreaterole/rolbypassrls all false.
-- ---------------------------------------------------------
