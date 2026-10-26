
-- REQUIREMENT TOOL V2
-- Repair 13 missing shared-primary-key foreign keys
-- Source: Data Dictionary, 03_FK_Relations

BEGIN;

-- PRECHECK: Do not add constraints if existing records
-- lack their corresponding EntityIdentity.

DO $$
DECLARE
    item record;
    orphan_count bigint;
BEGIN
    FOR item IN
        SELECT *
        FROM (VALUES
            ('acceptance_criteria', 'ac_id'),
            ('business_data_attributes', 'attribute_id'),
            ('business_data_definitions', 'data_definition_id'),
            ('business_decisions', 'decision_id'),
            ('business_rules', 'rule_id'),
            ('discovery_answers', 'answer_id'),
            ('evidence', 'evidence_id'),
            ('information_gaps', 'gap_id'),
            ('issues', 'issue_id'),
            ('requirements', 'requirement_id'),
            ('workflow_scenarios', 'workflow_id'),
            ('workflow_steps', 'step_id'),
            ('workflow_transitions', 'transition_id')
        ) AS t(table_name, column_name)
    LOOP
        EXECUTE format(
            'SELECT count(*)
             FROM public.%I t
             WHERE NOT EXISTS (
                 SELECT 1
                 FROM public.entity_identities i
                 WHERE i.entity_id = t.%I
             )',
            item.table_name,
            item.column_name
        )
        INTO orphan_count;

        IF orphan_count > 0 THEN
            RAISE EXCEPTION
                'Repair stopped: %.% has % records without EntityIdentity',
                item.table_name,
                item.column_name,
                orphan_count;
        END IF;
    END LOOP;
END $$;

-- ADD THE 13 APPROVED FOREIGN KEYS

ALTER TABLE public.acceptance_criteria
    ADD CONSTRAINT fk_ac_identity
    FOREIGN KEY (ac_id)
    REFERENCES public.entity_identities(entity_id);

ALTER TABLE public.business_data_attributes
    ADD CONSTRAINT fk_data_attribute_identity
    FOREIGN KEY (attribute_id)
    REFERENCES public.entity_identities(entity_id);

ALTER TABLE public.business_data_definitions
    ADD CONSTRAINT fk_data_definition_identity
    FOREIGN KEY (data_definition_id)
    REFERENCES public.entity_identities(entity_id);

ALTER TABLE public.business_decisions
    ADD CONSTRAINT fk_business_decision_identity
    FOREIGN KEY (decision_id)
    REFERENCES public.entity_identities(entity_id);

ALTER TABLE public.business_rules
    ADD CONSTRAINT fk_business_rule_identity
    FOREIGN KEY (rule_id)
    REFERENCES public.entity_identities(entity_id);

ALTER TABLE public.discovery_answers
    ADD CONSTRAINT fk_discovery_answer_identity
    FOREIGN KEY (answer_id)
    REFERENCES public.entity_identities(entity_id);

ALTER TABLE public.evidence
    ADD CONSTRAINT fk_evidence_identity
    FOREIGN KEY (evidence_id)
    REFERENCES public.entity_identities(entity_id);

ALTER TABLE public.information_gaps
    ADD CONSTRAINT fk_information_gap_identity
    FOREIGN KEY (gap_id)
    REFERENCES public.entity_identities(entity_id);

ALTER TABLE public.issues
    ADD CONSTRAINT fk_issue_identity
    FOREIGN KEY (issue_id)
    REFERENCES public.entity_identities(entity_id);

ALTER TABLE public.requirements
    ADD CONSTRAINT fk_requirement_identity
    FOREIGN KEY (requirement_id)
    REFERENCES public.entity_identities(entity_id);

ALTER TABLE public.workflow_scenarios
    ADD CONSTRAINT fk_workflow_identity
    FOREIGN KEY (workflow_id)
    REFERENCES public.entity_identities(entity_id);

ALTER TABLE public.workflow_steps
    ADD CONSTRAINT fk_workflow_step_identity
    FOREIGN KEY (step_id)
    REFERENCES public.entity_identities(entity_id);

ALTER TABLE public.workflow_transitions
    ADD CONSTRAINT fk_workflow_transition_identity
    FOREIGN KEY (transition_id)
    REFERENCES public.entity_identities(entity_id);

COMMIT;
