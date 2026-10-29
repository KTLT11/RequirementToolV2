-- =========================================================
-- REQUIREMENT TOOL V2 — Node.js Backend Migration 013
-- Grants for: Baseline Manifest + Validation Run infrastructure
-- (P2-D — minimal Structural Validation).
--
-- SCHEMA VERIFICATION (DDL read directly from Supabase Cloud via
-- pg_attribute/pg_constraint/pg_trigger/pg_get_functiondef before
-- writing this migration or any repository code - per the established
-- practice, since these 4 tables' creation migration is not present
-- in this repo's local migrations/ directory):
--
--   baseline_manifests(manifest_id pk, case_id fk cases, manifest_purpose
--     NN check-enum[VALIDATION/ASSESSMENT/DOCUMENT/HANDOFF],
--     manifest_status NN check-enum[DRAFT/FROZEN], frozen_at, manifest_sha256,
--     created_at, created_by fk auth.users). CHECK: FROZEN requires both
--     frozen_at AND manifest_sha256 set; DRAFT requires frozen_at NULL.
--
--   manifest_items(manifest_item_id pk, manifest_id fk baseline_manifests,
--     item_kind NN check-enum[ENTITY_REVISION/RELATION_REVISION/PUBLICATION],
--     entity_revision_id fk entity_revisions, relation_revision_id fk
--     relation_revisions, publication_id fk document_publications,
--     membership_role NN check-enum[INCLUDED/REFERENCED_ONLY/CONFIRMABLE/
--     HANDOFF_ARTIFACT], sort_order NN >0, item_notes). CHECK: exactly
--     one of entity_revision_id/relation_revision_id/publication_id
--     non-null, matching item_kind. UNIQUE(manifest_id, manifest_item_id),
--     UNIQUE(manifest_id, sort_order).
--
--   validation_runs(validation_run_id pk, case_id fk cases, manifest_id fk
--     baseline_manifests, policy_version_id fk definition_versions,
--     run_status NN check-enum[RUNNING/COMPLETED/FAILED_TO_RUN],
--     started_at NN, completed_at, triggered_by fk auth.users,
--     execution_context jsonb). CHECK: completed_at >= started_at.
--
--   validation_results(validation_result_id pk, validation_run_id fk
--     validation_runs, check_definition_version_id fk definition_versions,
--     target_entity_revision_id fk entity_revisions, result_outcome NN
--     check-enum[PASS/FAIL/UNKNOWN/N_A/WARNING], execution_status NN
--     check-enum[EXECUTED/FAILED_TO_RUN/NOT_EXECUTED], finding_summary,
--     severity, ai_confidence numeric(5,4) check 0..1, result_details
--     jsonb, evaluated_at NN).
--
-- Trigger behavior (read via pg_get_functiondef, governs the service
-- code's write order - see src/modules/validation/service.ts):
--   rt_guard_manifest_update  — once manifest_status = 'FROZEN', ANY
--     further UPDATE or DELETE on baseline_manifests raises an
--     exception (including re-freezing or un-freezing). DRAFT -> FROZEN
--     is the only state change this trigger allows through.
--   rt_guard_manifest_item    — INSERT/UPDATE/DELETE on manifest_items
--     is rejected once the owning manifest is FROZEN, and a manifest_id
--     may never be changed on an existing row. This means every
--     manifest_items row MUST be inserted BEFORE the single UPDATE that
--     freezes its manifest - never after.
--   rt_check_manifest_case    — validation_runs.case_id must equal
--     baseline_manifests.case_id for the manifest it references, or the
--     INSERT/UPDATE raises an exception. The service always derives
--     case_id for a validation_runs row from the manifest it just
--     created, never from a second independent client input.
--
-- No table here carries a FK to entity_identities - none of the 4 are
-- "registered, traceable, revisioned" business objects themselves
-- (they reference entity_revisions, they don't own a row in it), so no
-- registerEntity()/createRevision() calls appear in this batch's code.
--
-- Apply manually on Machine A, AFTER 001-012.
-- =========================================================

BEGIN;

-- ---------------------------------------------------------
-- 1. Grants.
--
--   baseline_manifests    SELECT, INSERT, UPDATE — create DRAFT, then
--                          the single UPDATE that freezes it
--                          (manifest_status/frozen_at/manifest_sha256).
--                          No DELETE — a frozen manifest is immutable
--                          by trigger anyway, and a draft manifest with
--                          a mistake is simply abandoned, not removed.
--
--   manifest_items         SELECT, INSERT — items are only ever added
--                           while the manifest is still DRAFT, never
--                           updated or removed afterward in this slice
--                           (no "remove one Requirement from a frozen
--                           baseline" operation exists, matching the
--                           trigger's own enforcement once FROZEN).
--
--   validation_runs        SELECT, INSERT, UPDATE — create RUNNING,
--                           then update to COMPLETED/FAILED_TO_RUN with
--                           completed_at.
--
--   validation_results     SELECT, INSERT — a result row is a point-in-
--                           time finding for one run; never updated or
--                           deleted (re-running validation creates a
--                           new validation_run with its own results,
--                           it does not mutate past ones).
-- ---------------------------------------------------------

GRANT SELECT, INSERT, UPDATE ON public.baseline_manifests TO app_backend;
GRANT SELECT, INSERT ON public.manifest_items TO app_backend;
GRANT SELECT, INSERT, UPDATE ON public.validation_runs TO app_backend;
GRANT SELECT, INSERT ON public.validation_results TO app_backend;

-- ---------------------------------------------------------
-- 2. RLS — same per-operation app_backend-scoped pattern as every
-- prior migration.
-- ---------------------------------------------------------

DROP POLICY IF EXISTS rt_app_backend_select ON public.baseline_manifests;
CREATE POLICY rt_app_backend_select ON public.baseline_manifests
    FOR SELECT TO app_backend USING (true);
DROP POLICY IF EXISTS rt_app_backend_insert ON public.baseline_manifests;
CREATE POLICY rt_app_backend_insert ON public.baseline_manifests
    FOR INSERT TO app_backend WITH CHECK (true);
DROP POLICY IF EXISTS rt_app_backend_update ON public.baseline_manifests;
CREATE POLICY rt_app_backend_update ON public.baseline_manifests
    FOR UPDATE TO app_backend USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS rt_app_backend_select ON public.manifest_items;
CREATE POLICY rt_app_backend_select ON public.manifest_items
    FOR SELECT TO app_backend USING (true);
DROP POLICY IF EXISTS rt_app_backend_insert ON public.manifest_items;
CREATE POLICY rt_app_backend_insert ON public.manifest_items
    FOR INSERT TO app_backend WITH CHECK (true);

DROP POLICY IF EXISTS rt_app_backend_select ON public.validation_runs;
CREATE POLICY rt_app_backend_select ON public.validation_runs
    FOR SELECT TO app_backend USING (true);
DROP POLICY IF EXISTS rt_app_backend_insert ON public.validation_runs;
CREATE POLICY rt_app_backend_insert ON public.validation_runs
    FOR INSERT TO app_backend WITH CHECK (true);
DROP POLICY IF EXISTS rt_app_backend_update ON public.validation_runs;
CREATE POLICY rt_app_backend_update ON public.validation_runs
    FOR UPDATE TO app_backend USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS rt_app_backend_select ON public.validation_results;
CREATE POLICY rt_app_backend_select ON public.validation_results
    FOR SELECT TO app_backend USING (true);
DROP POLICY IF EXISTS rt_app_backend_insert ON public.validation_results;
CREATE POLICY rt_app_backend_insert ON public.validation_results
    FOR INSERT TO app_backend WITH CHECK (true);

-- ---------------------------------------------------------
-- 3. Seed exactly 3 CHECK_RULE definitions - the only 3 structural
-- checks this batch implements, each traceable to an approved
-- SRS/Framework source. No other CHECK_RULE is invented:
--
--   REQ_HAS_AC            — FR-016/AC-CHK family's own spirit ("an AC
--                            must exist for a Requirement to be
--                            considered specified"): a Requirement row
--                            currently in the Case must have at least
--                            1 row in acceptance_criteria.
--   DISCOVERY_ANSWER_NOT_UNKNOWN_ON_COMPLETE — FR-011 ("a Module
--                            Application cannot be marked Complete
--                            while a required Discovery Answer is
--                            still Fail/Unknown"): for a
--                            module_applications row with
--                            application_status = 'COMPLETED', no
--                            discovery_answers row tied to it may have
--                            answer_status = 'UNKNOWN'.
--   INFORMATION_GAP_STILL_OPEN — flags any information_gaps row still
--                            OPEN or CLARIFYING at validation time, as
--                            a Fail/Warning finding — this check does
--                            NOT decide Case readiness itself (that is
--                            P3 Assessment), it only surfaces the gap
--                            as a structural validation result.
--
-- Same seeding pattern as migrations 006/007/011 (idempotent via
-- NOT EXISTS guard on definition_code).
-- ---------------------------------------------------------

DO $$
DECLARE
    v_definition_id uuid;
    v_check_rule record;
BEGIN
    FOR v_check_rule IN
        SELECT * FROM (VALUES
            ('REQ_HAS_AC',
             'Requirement phải có ít nhất 1 Acceptance Criteria (P3-FR-016/017, AC-CHK family). target_entity_revision_id = latest entity_revisions row của Requirement.'),
            ('DISCOVERY_ANSWER_NOT_UNKNOWN_ON_COMPLETE',
             'Module Application không được đánh dấu COMPLETED khi còn Discovery Answer của module đó ở answer_status = UNKNOWN (P3-FR-011). target_entity_revision_id = latest entity_revisions row của Discovery Answer vi phạm.'),
            ('INFORMATION_GAP_STILL_OPEN',
             'Information Gap còn OPEN hoặc CLARIFYING tại thời điểm chạy Validation Run được liệt kê là Fail/Warning, không tự quyết Case readiness (P3-FR-011, để P3 Assessment quyết định). target_entity_revision_id = latest entity_revisions row của Information Gap.')
        ) AS t(check_code, description)
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
            jsonb_build_object('source', 'Approved P2-D plan — minimal Structural Validation'),
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
--     AND table_name IN ('baseline_manifests', 'manifest_items',
--                         'validation_runs', 'validation_results')
--   ORDER BY table_name, privilege_type;
--   -- Expect: baseline_manifests/validation_runs -> INSERT, SELECT,
--   -- UPDATE; manifest_items/validation_results -> INSERT, SELECT.
--   -- No DELETE anywhere.
--
--   SELECT definition_code FROM public.definition_versions
--   WHERE definition_type = 'CHECK_RULE' ORDER BY definition_code;
--   -- Expect exactly 3 rows: DISCOVERY_ANSWER_NOT_UNKNOWN_ON_COMPLETE,
--   -- INFORMATION_GAP_STILL_OPEN, REQ_HAS_AC.
-- ---------------------------------------------------------
