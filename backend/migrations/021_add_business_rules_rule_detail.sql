-- =========================================================
-- REQUIREMENT TOOL V2 — Node.js Backend Migration 021
-- Adds business_rules.rule_detail (nullable JSONB) — B1.3
-- Structured Semantic Data, per the approved B1.2/B1.3 contract.
--
-- Purpose: business_rules carries exactly 8 columns today (confirmed
-- via information_schema before writing this migration: rule_id,
-- case_id, rule_code, rule_statement, rule_type, status,
-- current_revision_no, created_at) - rule_statement is the only
-- content column, a single free-text block with no way to separate
-- condition from action/outcome/formula/precedence. QG-06 v1.3's D05
-- (Business Rules & Validation) needs condition, action/outcome,
-- values/formula, units/rounding, and precedence/conflictResolution
-- as distinguishable fields, varying by rule complexity (simple
-- condition-outcome, calculation, multi-condition, decision table).
--
-- Deliberately additive and nullable, not a new table or a replacement
-- for rule_statement, which keeps its existing role as the
-- human-readable expression of the rule (per the approved contract:
-- "giữ rule_statement là phần diễn đạt dễ đọc"). The two are not
-- auto-synchronized in either direction by this migration or by the
-- service layer - keeping them consistent is a BA responsibility.
--
-- Shape is NOT enforced by a DB CHECK constraint (same posture as
-- rule_type/status already having none). Validation of
-- { profile_version, kind, ...fields-by-kind } lives in
-- src/modules/business-rules/service.ts, not here. Per the approved
-- contract, this validation checks SHAPE/TYPE/kind-vs-rule_type
-- compatibility only - a rule_detail missing a conditional business
-- field (e.g. a CALCULATION rule with no formula yet) is still
-- accepted as a valid partial draft; that completeness judgment
-- belongs to Quality Core/Document Coverage (B4), not to this CRUD
-- layer.
--
-- No GRANT/RLS change needed: app_backend already has SELECT/INSERT/
-- UPDATE on business_rules with permissive rt_app_backend_* policies
-- from migration 007 - a new column on an already-granted table needs
-- no new grant.
--
-- Apply manually on Machine A, AFTER 001-020 (no ordering dependency
-- on migration 020 beyond both being additive/independent - listed
-- after it only because both were approved in the same B1.3 batch).
-- =========================================================

BEGIN;

ALTER TABLE public.business_rules
    ADD COLUMN IF NOT EXISTS rule_detail jsonb NULL;

COMMIT;

-- ---------------------------------------------------------
-- Verification queries (run after commit, read-only):
--
--   SELECT column_name, data_type, is_nullable
--   FROM information_schema.columns
--   WHERE table_schema = 'public' AND table_name = 'business_rules'
--     AND column_name = 'rule_detail';
--   -- Expect: rule_detail | jsonb | YES
--
--   SELECT count(*) FROM public.business_rules WHERE rule_detail IS NOT NULL;
--   -- Expect: 0 immediately after this migration.
--
--   SELECT privilege_type FROM information_schema.role_table_grants
--   WHERE grantee = 'app_backend' AND table_name = 'business_rules'
--   ORDER BY privilege_type;
--   -- Expect: INSERT, SELECT, UPDATE (unchanged).
-- ---------------------------------------------------------
