-- =========================================================
-- REQUIREMENT TOOL V2 — Node.js Backend Migration 014
-- Grants for: Issue + IssueResolution (Blocker Management, part of
-- Phase 6 — Quality & Completeness Core). Also seeds 2 new CHECK_RULE
-- definitions that are genuinely SQL-evaluable from existing schema.
--
-- SCHEMA VERIFICATION (DDL read directly from Supabase Cloud via
-- pg_attribute/pg_constraint before writing this migration - these 2
-- tables' creation migration is not present in this repo's local
-- migrations/ directory, same situation as migration 013's 4 tables):
--
--   issues(issue_id pk fk entity_identities, case_id fk cases,
--     issue_code NN unique-per-case, issue_subject NN, issue_type NN
--     [GAP/CONFLICT/BLOCKER/QUALITY/CHANGE_REQUEST - free text, no
--     CHECK constraint exists for this column despite the Data
--     Dictionary listing those 5 values as a comment-only suggestion],
--     issue_status NN default OPEN [also free text, no CHECK -
--     OPEN/IN_CLARIFICATION/RESOLVED/REOPENED per the Data Dictionary's
--     own suggested vocabulary], severity, assignee_user_id fk
--     auth.users, source_check_result_id fk validation_results,
--     current_revision_no NN >0 default 1, opened_at NN default now(),
--     closed_at). CHECK: closed_at >= opened_at. UNIQUE(case_id,
--     issue_code).
--
--   issue_resolutions(resolution_id pk, issue_id fk issues,
--     resolution_method NN, resolution_summary NN, verification_outcome
--     NN [PASS/N_A_WITH_BASIS/REOPEN_REQUIRED per Data Dictionary -
--     also no DB CHECK], verification_result_id fk validation_results,
--     resolution_evidence_id fk evidence, resolution_decision_id fk
--     business_decisions, verified_at NN, verified_by NN fk auth.users).
--   No trigger exists on either table (checked pg_trigger - zero rows).
--
-- issues.issue_id DOES carry the entity_identities FK (fk_issue_identity)
-- - confirmed directly, unlike the Stakeholder/Form group - so Issue
-- uses registerEntity()/createRevision() like Requirement/Evidence/
-- Business Decision. issue_resolutions does NOT carry that FK and has
-- no revision column of its own - a resolution record is a point-in-
-- time append-only event, same pattern as evidence_review_records.
--
-- Apply manually on Machine A, AFTER 001-013.
-- =========================================================

BEGIN;

-- ---------------------------------------------------------
-- 1. Grants.
--
--   issues              SELECT, INSERT, UPDATE — create, then revise
--                        (issue_subject/issue_status/severity/
--                        assignee changes bump current_revision_no),
--                        and close (closed_at). No DELETE — a
--                        resolved/reopened issue is a status change,
--                        never a row removal.
--
--   issue_resolutions   SELECT, INSERT — a resolution event is
--                        append-only, matching every other "event
--                        record" table in the schema (evidence_review_
--                        records, evidence_confirmation_records).
-- ---------------------------------------------------------

GRANT SELECT, INSERT, UPDATE ON public.issues TO app_backend;
GRANT SELECT, INSERT ON public.issue_resolutions TO app_backend;

-- ---------------------------------------------------------
-- 2. RLS — same per-operation app_backend-scoped pattern as every
-- prior migration.
-- ---------------------------------------------------------

DROP POLICY IF EXISTS rt_app_backend_select ON public.issues;
CREATE POLICY rt_app_backend_select ON public.issues
    FOR SELECT TO app_backend USING (true);
DROP POLICY IF EXISTS rt_app_backend_insert ON public.issues;
CREATE POLICY rt_app_backend_insert ON public.issues
    FOR INSERT TO app_backend WITH CHECK (true);
DROP POLICY IF EXISTS rt_app_backend_update ON public.issues;
CREATE POLICY rt_app_backend_update ON public.issues
    FOR UPDATE TO app_backend USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS rt_app_backend_select ON public.issue_resolutions;
CREATE POLICY rt_app_backend_select ON public.issue_resolutions
    FOR SELECT TO app_backend USING (true);
DROP POLICY IF EXISTS rt_app_backend_insert ON public.issue_resolutions;
CREATE POLICY rt_app_backend_insert ON public.issue_resolutions
    FOR INSERT TO app_backend WITH CHECK (true);

-- ---------------------------------------------------------
-- 3. Seed exactly 2 new CHECK_RULE definitions - the only 2 beyond
-- P2-D's original 3 that are genuinely SQL-evaluable from data this
-- schema already records. Every other Framework checklist item
-- reviewed for this batch (REQ-QC-01..08, AC-CHK-01..05, CONF-CHK-
-- 01..07, DISC-CHK-01..11 except the parts already covered, READY-
-- CHK-01..04, HANDOFF-CHK-01..04) describes BA judgment in natural
-- language ("Pass khi requirement rõ ràng, không ambiguous..." / "Pass
-- khi không còn disagreement quan trọng...") with no condition a SQL
-- query can evaluate - these are deliberately NOT turned into
-- CHECK_RULE rows. They remain assessable only via a human-reviewed
-- outcome (see definition_body.review_mode below and
-- src/modules/validation/service.ts's recordHumanReviewedResultService).
--
--   EVIDENCE_COVERAGE_CONFIRMED — Evidence Quality Standard (Framework
--     0.6): a Business Decision that declares a source_evidence_id
--     (i.e. the BA chose to cite evidence as its basis) must cite
--     evidence that is actually CONFIRMED, not merely Unconfirmed or
--     an Assumption. This is "coverage" in the sense of "the Decision
--     that HAS a cited source must have a sufficient one" - it is NOT
--     "does the Case have enough Evidence everywhere" (an open-ended
--     judgment question with no SQL-evaluable criterion), and it is
--     NOT the same thing as the Evidence row simply existing. A
--     Decision with no source_evidence_id is N/A for this check (not
--     every Decision is required to cite Evidence), not FAIL.
--   DEP_BLOCKER_RECORDED — Dependency Check DEP-CHK-03 ("Blocker ảnh
--     hưởng implementation đã được ghi nhận... Pass khi blocker đã
--     được xác định và có trạng thái rõ"): this checks only that a
--     BLOCKER-type Issue, once it exists for the Case, carries a
--     recognized issue_status - it is explicitly NOT "no blocker
--     exists" and NOT "the blocker has been resolved". A Case with
--     zero BLOCKER issues is PASS (nothing to record). A Case with an
--     OPEN BLOCKER issue is also PASS for this specific check (the
--     blocker IS recorded with a clear status) - whether that open
--     blocker should prevent Readiness is a separate question decided
--     by Readiness Classification, not by this CHECK_RULE.
--
-- Both are seeded with definition_body.review_mode = 'DETERMINISTIC'
-- (evaluated automatically by service code, like P2-D's original 3) -
-- as opposed to the judgment-based checklist items, which a future
-- migration could seed as definition_body.review_mode =
-- 'HUMAN_REVIEWED' CHECK_RULE rows if/when a specific one is approved
-- (none are seeded by this migration - approval for those is out of
-- scope here per the explicit instruction not to turn checklist
-- prose into SQL rules without a clear, approved criterion).
--
-- Same idempotent seeding pattern as migrations 006/007/011/013.
-- ---------------------------------------------------------

DO $$
DECLARE
    v_definition_id uuid;
    v_check_rule record;
BEGIN
    FOR v_check_rule IN
        SELECT * FROM (VALUES
            ('EVIDENCE_COVERAGE_CONFIRMED',
             'Business Decision khai báo source_evidence_id phải trỏ tới Evidence có evidence_status = CONFIRMED (Framework 0.6 Evidence Quality Standard). Decision không khai báo source_evidence_id là N/A cho check này, không phải FAIL.',
             'DETERMINISTIC'),
            ('DEP_BLOCKER_RECORDED',
             'Issue loại BLOCKER trong Case phải có issue_status rõ ràng (DEP-CHK-03). Chỉ kiểm tra blocker đã được ghi nhận với trạng thái xác định, không kiểm tra blocker đã được giải quyết hay chưa - đó là input cho Readiness Classification, không phải kết luận của check này.',
             'DETERMINISTIC')
        ) AS t(check_code, description, review_mode)
    LOOP
        IF EXISTS (
            SELECT 1 FROM public.definition_versions
            WHERE definition_type = 'CHECK_RULE' AND definition_code = v_check_rule.check_code
        ) THEN
            CONTINUE;
        END IF;

        INSERT INTO public.entity_identities (entity_id, entity_type)
        VALUES (gen_random_uuid(), 'DEFINITION')
        RETURNING entity_id INTO v_definition_id;

        INSERT INTO public.definition_versions (
            definition_id, definition_type, definition_code, version_no,
            applicability, definition_body, content_sha256, status, published_at
        ) VALUES (
            v_definition_id,
            'CHECK_RULE',
            v_check_rule.check_code,
            1,
            jsonb_build_object('description', v_check_rule.description),
            jsonb_build_object(
                'review_mode', v_check_rule.review_mode,
                'source', 'Approved Phase 6 Quality & Completeness Core plan'
            ),
            encode(sha256(v_check_rule.check_code::bytea), 'hex'),
            'ACTIVE',
            now()
        );
    END LOOP;
END $$;

COMMIT;

-- ---------------------------------------------------------
-- Verification query (run after commit, read-only):
--
--   SELECT table_name, privilege_type
--   FROM information_schema.role_table_grants
--   WHERE grantee = 'app_backend'
--     AND table_name IN ('issues', 'issue_resolutions')
--   ORDER BY table_name, privilege_type;
--   -- Expect: issues -> INSERT, SELECT, UPDATE;
--   -- issue_resolutions -> INSERT, SELECT. No DELETE anywhere.
--
--   SELECT definition_code, definition_body->>'review_mode' AS review_mode
--   FROM public.definition_versions
--   WHERE definition_type = 'CHECK_RULE' ORDER BY definition_code;
--   -- Expect 5 rows total: DEP_BLOCKER_RECORDED, DISCOVERY_ANSWER_NOT_
--   -- UNKNOWN_ON_COMPLETE, EVIDENCE_COVERAGE_CONFIRMED, INFORMATION_
--   -- GAP_STILL_OPEN, REQ_HAS_AC - all review_mode = DETERMINISTIC.
-- ---------------------------------------------------------
