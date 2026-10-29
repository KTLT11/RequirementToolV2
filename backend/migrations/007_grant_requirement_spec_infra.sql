-- =========================================================
-- REQUIREMENT TOOL V2 — Node.js Backend Migration 007
-- Grants for: Requirement & Acceptance Criteria (P3-FR-017/018/019)
-- plus the Business Rule / Workflow / Data Definition tables that
-- back the Discovery-to-Requirement mapping described in
-- Requirement_Framework.md section 3.1 ("Discovery-to-Requirement
-- Mapping").
--
-- Tables already exist (applied earlier on the Migration branch, all
-- 8 created together in
-- 20261022072200_create_evidence_specification_schema.sql, group E
-- "REQUIREMENTS AND SPECIFICATION"):
--   requirements, acceptance_criteria, business_rules,
--   workflow_scenarios, workflow_steps, workflow_transitions,
--   business_data_definitions, business_data_attributes
--
-- SCHEMA VERIFICATION (full migration history read in chronological
-- order before writing this file, per the lesson from migration 006's
-- mistake — do not conclude FK presence from the creation migration
-- alone): the creation migration itself defines all 8 tables with
-- plain `uuid PRIMARY KEY DEFAULT gen_random_uuid()`, no FK to
-- entity_identities. The LATER repair migration
-- (20261022074857_repair_entity_identity_foreign_keys.sql) adds that
-- FK to ALL 8 of them:
--   fk_requirement_identity, fk_ac_identity, fk_business_rule_identity,
--   fk_workflow_identity, fk_workflow_step_identity,
--   fk_workflow_transition_identity, fk_data_definition_identity,
--   fk_data_attribute_identity
-- Checked the two other repair migrations
-- (20261022071002_repair_stakeholder_form_schema.sql,
-- 20261022080501_repair_schema_integrity.sql) and the trigger
-- migration (20261022080939_enforce_business_integrity_core.sql) —
-- none of them touch any of these 8 tables further, and none of
-- these 8 tables has any trigger attached anywhere in the schema.
-- Conclusion: all 8 tables use the EntityIdentity/EntityRevision
-- pattern (registerEntity + createRevision on every create/update),
-- same as Context/Scope/Discovery Answer/Information Gap.
--
-- Other constraints relevant to the planned repository code:
--   requirements            UNIQUE (case_id, requirement_code)
--   acceptance_criteria     UNIQUE (requirement_id, ac_code)
--   business_rules          UNIQUE (case_id, rule_code)
--   workflow_scenarios      UNIQUE (case_id, workflow_code)
--   workflow_steps          UNIQUE (workflow_id, step_key),
--                           UNIQUE (workflow_id, step_id)
--   workflow_transitions    UNIQUE (workflow_id, transition_key),
--                           composite FK (workflow_id, source_step_id)
--                           and (workflow_id, target_step_id) into
--                           workflow_steps(workflow_id, step_id) —
--                           both endpoints must belong to the same
--                           workflow, enforced by Postgres itself,
--                           not just application logic
--   business_data_definitions   UNIQUE (case_id, data_code)
--   business_data_attributes    UNIQUE (data_definition_id, attribute_code)
--
-- Apply manually on Machine A, AFTER 001-006. Written to be safely
-- re-runnable (DROP POLICY IF EXISTS before every CREATE POLICY).
-- =========================================================

BEGIN;

-- ---------------------------------------------------------
-- 1. Grants — SELECT/INSERT/UPDATE on all 8 tables, no DELETE
-- anywhere (matches the "no hard delete" posture already used by
-- every other migration: a Requirement is superseded/decomposed via
-- lifecycle_status and new rows, not row-deleted; same for AC,
-- BusinessRule, Workflow*, BusinessDataDefinition/Attribute).
--
-- Also grants on traceability_relations / relation_revisions
-- (existing tables, not created here) - needed for FR-018
-- (Requirement decomposition), which records the parent/child link
-- as a DECOMPOSED_FROM relation rather than a new schema column
-- (requirements has no parent_requirement_id; the approved design is
-- to reuse the existing Traceability infrastructure, per
-- Requirement_Framework.md's own traceability model, FR-016).
--
-- CORRECTED BY MIGRATION 008: SELECT/INSERT alone on
-- traceability_relations turned out to be insufficient - a trigger
-- fired by inserting into relation_revisions
-- (rt_check_relation_revision(), from migration
-- 20261022080939_enforce_business_integrity_core.sql) performs a row-
-- locking `SELECT ... FOR SHARE` against traceability_relations, and
-- Postgres RLS checks a row-locking SELECT against the table's
-- UPDATE policy, not its SELECT policy. This was only discoverable by
-- actually exercising the Requirement Split endpoint against live
-- data (unit tests never touch a real trigger) - see migration 008
-- for the fix (GRANT UPDATE + a matching RLS policy). This file is
-- left as originally applied; do not re-derive "SELECT/INSERT is
-- enough" from reading it alone.
-- ---------------------------------------------------------

GRANT SELECT, INSERT, UPDATE ON public.requirements TO app_backend;
GRANT SELECT, INSERT, UPDATE ON public.acceptance_criteria TO app_backend;
GRANT SELECT, INSERT, UPDATE ON public.business_rules TO app_backend;
GRANT SELECT, INSERT, UPDATE ON public.workflow_scenarios TO app_backend;
GRANT SELECT, INSERT, UPDATE ON public.workflow_steps TO app_backend;
GRANT SELECT, INSERT, UPDATE ON public.workflow_transitions TO app_backend;
GRANT SELECT, INSERT, UPDATE ON public.business_data_definitions TO app_backend;
GRANT SELECT, INSERT, UPDATE ON public.business_data_attributes TO app_backend;
GRANT SELECT, INSERT ON public.traceability_relations TO app_backend;
GRANT SELECT, INSERT ON public.relation_revisions TO app_backend;

-- ---------------------------------------------------------
-- 2. RLS — same per-operation app_backend-scoped pattern as
-- migrations 003-006. These 8 tables already have RLS ENABLED and
-- the existing `rt_ba_read` policy (left untouched).
-- ---------------------------------------------------------

DROP POLICY IF EXISTS rt_app_backend_select ON public.requirements;
CREATE POLICY rt_app_backend_select ON public.requirements
    FOR SELECT TO app_backend USING (true);
DROP POLICY IF EXISTS rt_app_backend_insert ON public.requirements;
CREATE POLICY rt_app_backend_insert ON public.requirements
    FOR INSERT TO app_backend WITH CHECK (true);
DROP POLICY IF EXISTS rt_app_backend_update ON public.requirements;
CREATE POLICY rt_app_backend_update ON public.requirements
    FOR UPDATE TO app_backend USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS rt_app_backend_select ON public.acceptance_criteria;
CREATE POLICY rt_app_backend_select ON public.acceptance_criteria
    FOR SELECT TO app_backend USING (true);
DROP POLICY IF EXISTS rt_app_backend_insert ON public.acceptance_criteria;
CREATE POLICY rt_app_backend_insert ON public.acceptance_criteria
    FOR INSERT TO app_backend WITH CHECK (true);
DROP POLICY IF EXISTS rt_app_backend_update ON public.acceptance_criteria;
CREATE POLICY rt_app_backend_update ON public.acceptance_criteria
    FOR UPDATE TO app_backend USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS rt_app_backend_select ON public.business_rules;
CREATE POLICY rt_app_backend_select ON public.business_rules
    FOR SELECT TO app_backend USING (true);
DROP POLICY IF EXISTS rt_app_backend_insert ON public.business_rules;
CREATE POLICY rt_app_backend_insert ON public.business_rules
    FOR INSERT TO app_backend WITH CHECK (true);
DROP POLICY IF EXISTS rt_app_backend_update ON public.business_rules;
CREATE POLICY rt_app_backend_update ON public.business_rules
    FOR UPDATE TO app_backend USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS rt_app_backend_select ON public.workflow_scenarios;
CREATE POLICY rt_app_backend_select ON public.workflow_scenarios
    FOR SELECT TO app_backend USING (true);
DROP POLICY IF EXISTS rt_app_backend_insert ON public.workflow_scenarios;
CREATE POLICY rt_app_backend_insert ON public.workflow_scenarios
    FOR INSERT TO app_backend WITH CHECK (true);
DROP POLICY IF EXISTS rt_app_backend_update ON public.workflow_scenarios;
CREATE POLICY rt_app_backend_update ON public.workflow_scenarios
    FOR UPDATE TO app_backend USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS rt_app_backend_select ON public.workflow_steps;
CREATE POLICY rt_app_backend_select ON public.workflow_steps
    FOR SELECT TO app_backend USING (true);
DROP POLICY IF EXISTS rt_app_backend_insert ON public.workflow_steps;
CREATE POLICY rt_app_backend_insert ON public.workflow_steps
    FOR INSERT TO app_backend WITH CHECK (true);
DROP POLICY IF EXISTS rt_app_backend_update ON public.workflow_steps;
CREATE POLICY rt_app_backend_update ON public.workflow_steps
    FOR UPDATE TO app_backend USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS rt_app_backend_select ON public.workflow_transitions;
CREATE POLICY rt_app_backend_select ON public.workflow_transitions
    FOR SELECT TO app_backend USING (true);
DROP POLICY IF EXISTS rt_app_backend_insert ON public.workflow_transitions;
CREATE POLICY rt_app_backend_insert ON public.workflow_transitions
    FOR INSERT TO app_backend WITH CHECK (true);
DROP POLICY IF EXISTS rt_app_backend_update ON public.workflow_transitions;
CREATE POLICY rt_app_backend_update ON public.workflow_transitions
    FOR UPDATE TO app_backend USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS rt_app_backend_select ON public.business_data_definitions;
CREATE POLICY rt_app_backend_select ON public.business_data_definitions
    FOR SELECT TO app_backend USING (true);
DROP POLICY IF EXISTS rt_app_backend_insert ON public.business_data_definitions;
CREATE POLICY rt_app_backend_insert ON public.business_data_definitions
    FOR INSERT TO app_backend WITH CHECK (true);
DROP POLICY IF EXISTS rt_app_backend_update ON public.business_data_definitions;
CREATE POLICY rt_app_backend_update ON public.business_data_definitions
    FOR UPDATE TO app_backend USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS rt_app_backend_select ON public.business_data_attributes;
CREATE POLICY rt_app_backend_select ON public.business_data_attributes
    FOR SELECT TO app_backend USING (true);
DROP POLICY IF EXISTS rt_app_backend_insert ON public.business_data_attributes;
CREATE POLICY rt_app_backend_insert ON public.business_data_attributes
    FOR INSERT TO app_backend WITH CHECK (true);
DROP POLICY IF EXISTS rt_app_backend_update ON public.business_data_attributes;
CREATE POLICY rt_app_backend_update ON public.business_data_attributes
    FOR UPDATE TO app_backend USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS rt_app_backend_select ON public.traceability_relations;
CREATE POLICY rt_app_backend_select ON public.traceability_relations
    FOR SELECT TO app_backend USING (true);
DROP POLICY IF EXISTS rt_app_backend_insert ON public.traceability_relations;
CREATE POLICY rt_app_backend_insert ON public.traceability_relations
    FOR INSERT TO app_backend WITH CHECK (true);

DROP POLICY IF EXISTS rt_app_backend_select ON public.relation_revisions;
CREATE POLICY rt_app_backend_select ON public.relation_revisions
    FOR SELECT TO app_backend USING (true);
DROP POLICY IF EXISTS rt_app_backend_insert ON public.relation_revisions;
CREATE POLICY rt_app_backend_insert ON public.relation_revisions
    FOR INSERT TO app_backend WITH CHECK (true);

-- ---------------------------------------------------------
-- 3. Rule Registry seed — DECOMPOSED_FROM relation type.
--
-- Used by FR-018 (Requirement decomposition): when a Requirement is
-- split, each new child Requirement gets one traceability_relations
-- row with source_entity_id = child, target_entity_id = parent,
-- relation_type_version_id -> this definition. This is a relation
-- *type* registration only, not a general rule or validation
-- definition - no check logic is evaluated against it anywhere in
-- this slice.
--
-- Idempotent via the same NOT EXISTS guard pattern as migration 006.
-- ---------------------------------------------------------

DO $$
DECLARE
    v_definition_id uuid;
BEGIN
    IF EXISTS (
        SELECT 1 FROM public.definition_versions
        WHERE definition_type = 'RELATION_TYPE' AND definition_code = 'DECOMPOSED_FROM'
    ) THEN
        RETURN;
    END IF;

    INSERT INTO public.entity_identities (entity_id, entity_type)
    VALUES (gen_random_uuid(), 'DEFINITION')
    RETURNING entity_id INTO v_definition_id;

    INSERT INTO public.definition_versions (
        definition_id, definition_type, definition_code, version_no,
        applicability, definition_body, content_sha256, status, published_at
    ) VALUES (
        v_definition_id,
        'RELATION_TYPE',
        'DECOMPOSED_FROM',
        1,
        jsonb_build_object(
            'description',
            'Áp dụng khi một Requirement được tách thành nhiều Requirement con có thể kiểm chứng độc lập (P3-FR-018). source_entity_id = Requirement con, target_entity_id = Requirement cha.'
        ),
        jsonb_build_object(
            'source_role', 'CHILD_REQUIREMENT',
            'target_role', 'PARENT_REQUIREMENT',
            'source', 'Requirement_Framework.md section 3.1.2 (Requirement Decomposition & Traceability)'
        ),
        encode(sha256('DECOMPOSED_FROM'::bytea), 'hex'),
        'ACTIVE',
        now()
    );
END $$;

COMMIT;

-- ---------------------------------------------------------
-- Verification query (run after commit, read-only):
--
--   SELECT table_name, privilege_type
--   FROM information_schema.role_table_grants
--   WHERE grantee = 'app_backend'
--     AND table_name IN ('requirements', 'acceptance_criteria',
--                         'business_rules', 'workflow_scenarios',
--                         'workflow_steps', 'workflow_transitions',
--                         'business_data_definitions',
--                         'business_data_attributes')
--   ORDER BY table_name, privilege_type;
--   -- Expect all 8 tables -> INSERT, SELECT, UPDATE. No DELETE.
-- ---------------------------------------------------------
