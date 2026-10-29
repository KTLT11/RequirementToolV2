-- =========================================================
-- REQUIREMENT TOOL V2 — Node.js Backend Migration 017
-- Backfills definition_body.review_mode = 'DETERMINISTIC' on the 3
-- CHECK_RULE definitions seeded by migration 013 (REQ_HAS_AC,
-- DISCOVERY_ANSWER_NOT_UNKNOWN_ON_COMPLETE, INFORMATION_GAP_STILL_OPEN).
--
-- Root cause: migration 013 was written before this batch's
-- review_mode distinction (DETERMINISTIC vs HUMAN_REVIEWED) existed,
-- so those 3 rows never got the field at all - only migration 014's 2
-- new rules (EVIDENCE_COVERAGE_CONFIRMED, DEP_BLOCKER_RECORDED) were
-- seeded with it from the start. Functionally this was never a bug:
-- all 5 are evaluated automatically by createValidationRunService
-- (src/modules/validation/service.ts), none go through the human-
-- reviewed path - but the missing field makes the data inconsistent
-- for anyone reading definition_body directly, and
-- findCheckRuleWithReviewMode()/findAllActiveCheckRuleMeta() would
-- return review_mode = null for these 3 instead of the true value.
-- Caught by direct inspection after applying migration 014, not by a
-- live test failure.
--
-- Apply manually on Machine A, AFTER 001-016.
-- =========================================================

BEGIN;

UPDATE public.definition_versions
SET definition_body = definition_body || jsonb_build_object('review_mode', 'DETERMINISTIC')
WHERE definition_type = 'CHECK_RULE'
  AND definition_code IN (
    'REQ_HAS_AC',
    'DISCOVERY_ANSWER_NOT_UNKNOWN_ON_COMPLETE',
    'INFORMATION_GAP_STILL_OPEN'
  )
  AND status = 'ACTIVE'
  AND NOT (definition_body ? 'review_mode');

COMMIT;

-- ---------------------------------------------------------
-- Verification query (run after commit, read-only):
--
--   SELECT definition_code, definition_body->>'review_mode' AS review_mode,
--          definition_body->>'obligation_level' AS obligation_level
--   FROM public.definition_versions
--   WHERE definition_type = 'CHECK_RULE'
--   ORDER BY definition_code;
--   -- Expect all 5 rows to show review_mode = DETERMINISTIC and
--   -- obligation_level = UNDETERMINED.
-- ---------------------------------------------------------
