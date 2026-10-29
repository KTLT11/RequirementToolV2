-- =========================================================
-- REQUIREMENT TOOL V2 — Node.js Backend Migration 011
-- Seed: 2 additional RELATION_TYPE definitions for Traceability
-- (P3-FR-016), used by Evidence -> Business Decision and Business
-- Decision -> Requirement links.
--
-- No new table, no grant changes - traceability_relations and
-- relation_revisions were already granted to app_backend in
-- migration 007 (for DECOMPOSED_FROM). This migration only adds Rule
-- Registry rows, same seeding pattern as migrations 006 (Module/
-- Question definitions) and 007 (DECOMPOSED_FROM).
--
-- Only 2 relation types are seeded here, both with a concrete,
-- traceable use case already described in the approved plan:
--   EVIDENCE_SUPPORTS_DECISION  — source = Evidence, target =
--     BusinessDecision. Lets a BA record which Evidence a Business
--     Decision rests on (FR-014/FR-016 "requirement/AC traceable back
--     to the evidence/decision that justifies it").
--   DECISION_SUPPORTS_REQUIREMENT — source = BusinessDecision, target
--     = Requirement. Lets a BA record which Business Decision
--     justifies a Requirement's content.
-- No other relation type is invented beyond these two - any further
-- relation type needs its own approval before being seeded.
--
-- Apply manually on Machine A, AFTER 001-010. Idempotent via the same
-- NOT EXISTS guard pattern as migrations 006/007.
-- =========================================================

BEGIN;

DO $$
DECLARE
    v_definition_id uuid;
    v_relation_type record;
BEGIN
    FOR v_relation_type IN
        SELECT * FROM (VALUES
            ('EVIDENCE_SUPPORTS_DECISION', 'EVIDENCE', 'BUSINESS_DECISION',
             'Áp dụng khi một Evidence được dùng làm căn cứ cho một Business Decision (P3-FR-014/016). source_entity_id = Evidence, target_entity_id = Business Decision.'),
            ('DECISION_SUPPORTS_REQUIREMENT', 'BUSINESS_DECISION', 'REQUIREMENT',
             'Áp dụng khi một Business Decision là căn cứ hình thành nội dung một Requirement (P3-FR-016/017). source_entity_id = Business Decision, target_entity_id = Requirement.')
        ) AS t(relation_code, source_role, target_role, description)
    LOOP
        IF EXISTS (
            SELECT 1 FROM public.definition_versions
            WHERE definition_type = 'RELATION_TYPE' AND definition_code = v_relation_type.relation_code
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
            'RELATION_TYPE',
            v_relation_type.relation_code,
            1,
            jsonb_build_object('description', v_relation_type.description),
            jsonb_build_object(
                'source_role', v_relation_type.source_role,
                'target_role', v_relation_type.target_role,
                'source', 'Approved P2-C plan — Traceability relation types'
            ),
            encode(sha256(v_relation_type.relation_code::bytea), 'hex'),
            'ACTIVE',
            now()
        );
    END LOOP;
END $$;

COMMIT;

-- ---------------------------------------------------------
-- Verification query (run after commit, read-only):
--
--   SELECT definition_code, definition_body->>'source_role' AS source_role,
--          definition_body->>'target_role' AS target_role
--   FROM public.definition_versions
--   WHERE definition_type = 'RELATION_TYPE'
--   ORDER BY definition_code;
--   -- Expect 3 rows total: DECOMPOSED_FROM (from migration 007),
--   -- DECISION_SUPPORTS_REQUIREMENT, EVIDENCE_SUPPORTS_DECISION.
-- ---------------------------------------------------------
