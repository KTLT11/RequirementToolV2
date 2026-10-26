
-- REQUIREMENT TOOL V2
-- SECURITY PHASE 1
-- RLS for the 50 approved application tables
--
-- BA: SELECT only, with trusted app_metadata.rt_role
-- anon: no direct table access
-- authenticated non-BA: no direct table access
-- writes: server-side authorized workflow only

BEGIN;

DO $$
DECLARE
    v_tables text[] := ARRAY[
        'cases',
        'incoming_requests',
        'case_request_associations',
        'stakeholders',
        'case_stakeholders',
        'role_assignments',
        'authority_assignments',
        'stakeholder_forms',
        'form_versions',
        'form_question_items',
        'form_responses',
        'form_answers',
        'public_access_grants',
        'module_applications',
        'discovery_answers',
        'information_gaps',
        'evidence',
        'evidence_review_records',
        'evidence_confirmation_records',
        'business_decisions',
        'issues',
        'issue_resolutions',
        'requirements',
        'acceptance_criteria',
        'business_rules',
        'workflow_scenarios',
        'workflow_steps',
        'workflow_transitions',
        'business_data_definitions',
        'business_data_attributes',
        'entity_identities',
        'entity_revisions',
        'definition_versions',
        'traceability_relations',
        'relation_revisions',
        'baseline_manifests',
        'manifest_items',
        'validation_runs',
        'validation_results',
        'assessment_records',
        'audit_events',
        'business_contexts',
        'case_scopes',
        'documents',
        'document_snapshots',
        'document_publications',
        'customer_confirmations',
        'confirmation_scope_items',
        'handoff_baselines',
        'dev_review_records'
    ];

    v_table text;
    v_count integer;
BEGIN
    -- Verify all 50 application tables exist before modifying grants.
    IF array_length(v_tables, 1) <> 50 THEN
        RAISE EXCEPTION 'Expected exactly 50 application tables';
    END IF;

    FOREACH v_table IN ARRAY v_tables
    LOOP
        IF to_regclass(format('public.%I', v_table)) IS NULL THEN
            RAISE EXCEPTION 'Missing application table: %', v_table;
        END IF;
    END LOOP;

    -- Remove existing policies and grants only for the specified
    -- application tables. Keep PostgreSQL ownership and service_role.

    FOREACH v_table IN ARRAY v_tables
    LOOP
        EXECUTE format(
            'ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',
            v_table
        );

        -- Existing policies could grant broader access.
        -- Stop rather than silently deleting unknown policies.
        SELECT count(*)
        INTO v_count
        FROM pg_policies
        WHERE schemaname = 'public'
          AND tablename = v_table;

        IF v_count > 0 THEN
            RAISE EXCEPTION
                'Table % already has % policies; review before continuing',
                v_table, v_count;
        END IF;

        EXECUTE format(
            'REVOKE ALL ON TABLE public.%I
             FROM PUBLIC, anon, authenticated',
            v_table
        );

        EXECUTE format(
            'GRANT SELECT ON TABLE public.%I TO authenticated',
            v_table
        );

        EXECUTE format(
            'CREATE POLICY rt_ba_read
             ON public.%I
             FOR SELECT
             TO authenticated
             USING (
                 (SELECT auth.uid()) IS NOT NULL
                 AND
                 (
                     SELECT auth.jwt() #>> ''{app_metadata,rt_role}''
                 ) = ''BA''
             )',
            v_table
        );
    END LOOP;
END;
$$;

COMMIT;
