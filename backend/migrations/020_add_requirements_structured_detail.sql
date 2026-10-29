-- =========================================================
-- REQUIREMENT TOOL V2 — Node.js Backend Migration 020
-- Adds requirements.structured_detail (nullable JSONB) — B1.3
-- Structured Semantic Data, per the approved B1.2/B1.3 contract.
--
-- Purpose: requirements.statement is the only column carrying a
-- Requirement's behavior today (confirmed via information_schema
-- before writing this migration: requirement_id, case_id,
-- requirement_code, requirement_type, title, statement, rationale,
-- lifecycle_status, priority, current_revision_no, created_at,
-- updated_at — 12 columns, none structured beyond that one free-text
-- field). QG-06 v1.3's D04 (Functional Requirement Specifications)
-- and D10 (Non-functional Requirements) need actor/trigger/
-- preconditions/conditions/expected_outcome (Functional) or
-- quality_attribute/measurable_target/measurement_condition/
-- verification_method (NFR), plus a conditional Reporting profile
-- that can coexist with a Functional profile on the same row - none
-- of which requirements carries today.
--
-- Deliberately additive and nullable, not a new table: the approved
-- contract explicitly rejected a separate NFR table/requirement_type
-- and treats this as one logical "Document Model" style payload per
-- QG-06's own B1 ("logical model, không ép tạo một database table
-- cho mỗi object"). No existing column, constraint, or API contract
-- changes - a caller that never sends structured_detail sees no
-- behavior change at all; the column reads back NULL.
--
-- Shape is NOT enforced by a DB CHECK constraint (same posture as
-- requirement_type/lifecycle_status already having none - see
-- requirements/service.ts's own comment on that). Validation of
-- { profile_version, functional?, nfr?, reporting? } and each
-- profile's field types lives in src/modules/requirements/service.ts,
-- not here - this migration only makes the column exist and
-- grantable. Per the approved contract, this validation checks
-- SHAPE/TYPE only: it never rejects a write merely because a
-- profile is present but missing one of QG-06's "mandatory when this
-- section applies" fields - that completeness judgment belongs to
-- Quality Core/Document Coverage (B4), not to this CRUD layer.
--
-- No GRANT/RLS change needed: app_backend already has SELECT/INSERT/
-- UPDATE on requirements with permissive rt_app_backend_* policies
-- (USING/WITH CHECK (true)) from migration 007 - a new column on an
-- already-granted table needs no new grant.
--
-- Apply manually on Machine A, AFTER 001-019.
-- =========================================================

BEGIN;

ALTER TABLE public.requirements
    ADD COLUMN IF NOT EXISTS structured_detail jsonb NULL;

COMMIT;

-- ---------------------------------------------------------
-- Verification queries (run after commit, read-only):
--
--   SELECT column_name, data_type, is_nullable
--   FROM information_schema.columns
--   WHERE table_schema = 'public' AND table_name = 'requirements'
--     AND column_name = 'structured_detail';
--   -- Expect: structured_detail | jsonb | YES
--
--   -- Existing rows are unaffected (column added as NULL, no
--   -- backfill):
--   SELECT count(*) FROM public.requirements WHERE structured_detail IS NOT NULL;
--   -- Expect: 0 immediately after this migration.
--
--   -- No grant change needed - confirm app_backend's existing grants
--   -- on requirements are unchanged:
--   SELECT privilege_type FROM information_schema.role_table_grants
--   WHERE grantee = 'app_backend' AND table_name = 'requirements'
--   ORDER BY privilege_type;
--   -- Expect: INSERT, SELECT, UPDATE (same as before this migration).
-- ---------------------------------------------------------
