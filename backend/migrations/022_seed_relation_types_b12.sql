-- =========================================================
-- REQUIREMENT TOOL V2 — Node.js Backend Migration 022
-- Seed: 4 additional RELATION_TYPE definitions for Traceability
-- (P3-FR-016) — B1.2 Typed Relation Contract, per the approved
-- contract.
--
-- Same seeding pattern as migrations 007 (DECOMPOSED_FROM) and 011
-- (EVIDENCE_SUPPORTS_DECISION, DECISION_SUPPORTS_REQUIREMENT). No new
-- table, no grant changes - traceability_relations/relation_revisions
-- already granted to app_backend since migration 007. The Generic
-- Traceability API (src/modules/traceability/service.ts) already
-- validates any RELATION_TYPE's source_role/target_role generically -
-- no code change is needed for these 4 to become usable, only this
-- seed.
--
-- Exactly 4 relation types are seeded here, each with a concrete use
-- case from the approved B1.2 contract:
--   RULE_APPLIES_TO_REQUIREMENT    — source = BusinessRule, target =
--     Requirement. A rule governs/constrains a requirement's behavior
--     (QG-06 D04 ruleRefs / C07 ruleReferences).
--   REQUIREMENT_FOLLOWS_WORKFLOW   — source = Requirement, target =
--     WorkflowScenario. A requirement is realized following a
--     specific workflow/scenario (QG-06 D02 workflowReference / C07
--     flowScenarioReferences).
--   RULE_REFERENCES_DATA_DEFINITION — source = BusinessRule, target =
--     BusinessDataDefinition. A rule's condition/formula semantically
--     refers to a business data definition (QG-06 D05
--     applicability / D06 relatedReq-contractRefs).
--   DECISION_SUPPORTS_RULE          — source = BusinessDecision,
--     target = BusinessRule. A business decision is the direct
--     provenance/rationale for a rule - deliberately distinct from
--     (and not inferable from) the existing Rule->Requirement<-Decision
--     paths, which only prove both relate to the same requirement, not
--     that the decision justifies the rule itself.
--
-- No other relation type is seeded in this batch. REQUIREMENT_HAS_
-- EXCEPTION_PATH and NFR_APPLIES_TO_REQUIREMENT, discussed during
-- B1.2/B1.3 design, are explicitly NOT seeded here - insufficient
-- evidence of their entity semantics was approved yet; seeding them
-- needs its own separate approval.
--
-- Same-Case constraint: deliberately NOT added for any of these 4,
-- matching the existing EVIDENCE_SUPPORTS_DECISION/DECISION_SUPPORTS_
-- REQUIREMENT precedent and the approved B1.2 decision not to invent
-- a new Case-level ACL/constraint in this MVP slice. Cross-Case
-- linking remains allowed, same as the Data Dictionary's own note on
-- TraceabilityRelation.
--
-- Apply manually on Machine A, AFTER 001-021. Idempotent via the same
-- NOT EXISTS guard pattern as migrations 006/007/011.
-- =========================================================

BEGIN;

DO $$
DECLARE
    v_definition_id uuid;
    v_relation_type record;
BEGIN
    FOR v_relation_type IN
        SELECT * FROM (VALUES
            ('RULE_APPLIES_TO_REQUIREMENT', 'BUSINESS_RULE', 'REQUIREMENT',
             'Áp dụng khi một Business Rule chi phối/ràng buộc hành vi của một Requirement (QG-06 v1.3 D04 ruleRefs / C07 ruleReferences). source_entity_id = Business Rule, target_entity_id = Requirement.'),
            ('REQUIREMENT_FOLLOWS_WORKFLOW', 'REQUIREMENT', 'WORKFLOW_SCENARIO',
             'Áp dụng khi một Requirement được thực hiện theo một Workflow Scenario cụ thể (QG-06 v1.3 D02 workflowReference / C07 flowScenarioReferences). source_entity_id = Requirement, target_entity_id = Workflow Scenario.'),
            ('RULE_REFERENCES_DATA_DEFINITION', 'BUSINESS_RULE', 'BUSINESS_DATA_DEFINITION',
             'Áp dụng khi điều kiện/công thức của một Business Rule tham chiếu ngữ nghĩa một Business Data Definition (QG-06 v1.3 D05 applicability / D06 relatedReq-contractRefs). source_entity_id = Business Rule, target_entity_id = Business Data Definition.'),
            ('DECISION_SUPPORTS_RULE', 'BUSINESS_DECISION', 'BUSINESS_RULE',
             'Áp dụng khi một Business Decision là căn cứ trực tiếp hình thành một Business Rule - không suy diễn từ quan hệ gián tiếp Rule->Requirement<-Decision. source_entity_id = Business Decision, target_entity_id = Business Rule.')
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
                'source', 'Approved B1.2 Typed Relation Contract'
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
--   -- Expect 7 rows total: DECISION_SUPPORTS_REQUIREMENT,
--   -- DECISION_SUPPORTS_RULE, DECOMPOSED_FROM, EVIDENCE_SUPPORTS_DECISION,
--   -- RULE_APPLIES_TO_REQUIREMENT, RULE_REFERENCES_DATA_DEFINITION,
--   -- REQUIREMENT_FOLLOWS_WORKFLOW.
-- ---------------------------------------------------------
