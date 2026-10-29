-- =========================================================
-- REQUIREMENT TOOL V2 — Node.js Backend Migration 016
-- Adds obligation_level to all 5 existing CHECK_RULE definitions
-- (REQ_HAS_AC, DISCOVERY_ANSWER_NOT_UNKNOWN_ON_COMPLETE, INFORMATION_
-- GAP_STILL_OPEN from migration 013; EVIDENCE_COVERAGE_CONFIRMED,
-- DEP_BLOCKER_RECORDED from migration 014) — needed by Quality Gate
-- (src/modules/assessment/service.ts) to decide which checks must
-- all PASS before outcome can ever be QUALITY=PASS.
--
-- Reviewed the full SRS (FR-016 through FR-024, Quality Validation /
-- Validation Finding / Rule Registry sections) specifically looking
-- for an explicit mandatory/conditional/advisory classification per
-- check - none exists. FR-020 AC-04 only establishes the general
-- "waiver cannot bypass a mandatory checkpoint" principle without
-- naming which of these 5 checks that applies to.
--
-- Per explicit instruction: do not infer obligation_level from a
-- check's outcome vocabulary or name (e.g. INFORMATION_GAP_STILL_OPEN
-- defaulting to WARNING is NOT evidence it is "advisory" - that would
-- be inferring policy from implementation, exactly what was
-- prohibited). Since no approved policy document names an
-- obligation_level for any of these 5, ALL 5 are set to UNDETERMINED
-- here, not just the 2 new ones - this is a correction, not a
-- continuation, of migrations 013/014's seed (which set no
-- obligation_level field at all).
--
-- IMPORTANT: this does NOT change result_outcome of any existing
-- validation_results row, and does NOT change how
-- createValidationRunService computes PASS/FAIL/N_A/WARNING for any
-- individual check - those are still computed and stored exactly as
-- before, as the real, executed result of that check. obligation_level
-- only affects assessment/service.ts's Quality Gate aggregation step:
-- a Case cannot be assessed QUALITY=PASS while any APPLICABLE check
-- still has obligation_level = UNDETERMINED, regardless of whether
-- that check's own result_outcome was PASS - the individual check
-- result is reported as-is, but the aggregate Quality Gate outcome
-- stays UNKNOWN/INCOMPLETE until a human approves an obligation_level
-- for it via a future migration.
--
-- Apply manually on Machine A, AFTER 001-015.
-- =========================================================

BEGIN;

UPDATE public.definition_versions
SET definition_body = definition_body || jsonb_build_object('obligation_level', 'UNDETERMINED')
WHERE definition_type = 'CHECK_RULE'
  AND definition_code IN (
    'REQ_HAS_AC',
    'DISCOVERY_ANSWER_NOT_UNKNOWN_ON_COMPLETE',
    'INFORMATION_GAP_STILL_OPEN',
    'EVIDENCE_COVERAGE_CONFIRMED',
    'DEP_BLOCKER_RECORDED'
  )
  AND status = 'ACTIVE'
  AND NOT (definition_body ? 'obligation_level');

COMMIT;

-- ---------------------------------------------------------
-- Verification query (run after commit, read-only):
--
--   SELECT definition_code, definition_body->>'obligation_level' AS obligation_level
--   FROM public.definition_versions
--   WHERE definition_type = 'CHECK_RULE'
--   ORDER BY definition_code;
--   -- Expect all 5 rows (DEP_BLOCKER_RECORDED, DISCOVERY_ANSWER_NOT_
--   -- UNKNOWN_ON_COMPLETE, EVIDENCE_COVERAGE_CONFIRMED, INFORMATION_
--   -- GAP_STILL_OPEN, REQ_HAS_AC) to show obligation_level =
--   -- UNDETERMINED. This batch's report will list these 5 as needing
--   -- an explicit, approved obligation_level decision before Quality
--   -- Gate can ever report PASS against any Case that has data
--   -- applicable to them.
-- ---------------------------------------------------------
