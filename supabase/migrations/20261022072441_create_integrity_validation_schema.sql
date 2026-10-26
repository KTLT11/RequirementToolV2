
-- REQUIREMENT TOOL V2
-- MIGRATION: IDENTITY, REVISION, TRACEABILITY,
-- MANIFEST, VALIDATION AND REGISTRY
-- Based on Data Dictionary 50 tables

BEGIN;

-- 1. ENTITY IDENTITY
CREATE TABLE public.entity_identities (
    entity_id uuid PRIMARY KEY,
    entity_type varchar(60) NOT NULL,
    registered_at timestamptz NOT NULL DEFAULT now(),
    retired_at timestamptz,
    CHECK (retired_at IS NULL OR retired_at >= registered_at)
);

-- 2. ENTITY REVISION
CREATE TABLE public.entity_revisions (
    entity_revision_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    entity_id uuid NOT NULL
        REFERENCES public.entity_identities(entity_id),
    revision_no integer NOT NULL CHECK (revision_no > 0),
    content_snapshot jsonb NOT NULL,
    content_sha256 char(64) NOT NULL,
    change_summary text,
    created_at timestamptz NOT NULL DEFAULT now(),
    created_by uuid NOT NULL REFERENCES auth.users(id),
    UNIQUE (entity_id, revision_no),
    UNIQUE (entity_revision_id, entity_id),
    CHECK (content_sha256 ~ '^[0-9a-fA-F]{64}$')
);

-- 3. DEFINITION VERSION
CREATE TABLE public.definition_versions (
    definition_version_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    definition_id uuid NOT NULL
        REFERENCES public.entity_identities(entity_id),
    definition_type varchar(40) NOT NULL,
    definition_code varchar(100) NOT NULL,
    version_no integer NOT NULL CHECK (version_no > 0),
    applicability jsonb NOT NULL,
    definition_body jsonb NOT NULL,
    content_sha256 char(64) NOT NULL,
    status varchar(26) NOT NULL,
    published_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (definition_id, version_no),
    CHECK (content_sha256 ~ '^[0-9a-fA-F]{64}$')
);

-- 4. TRACEABILITY RELATION
CREATE TABLE public.traceability_relations (
    relation_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    relation_type_version_id uuid NOT NULL
        REFERENCES public.definition_versions(definition_version_id),
    source_entity_id uuid NOT NULL
        REFERENCES public.entity_identities(entity_id),
    target_entity_id uuid NOT NULL
        REFERENCES public.entity_identities(entity_id),
    relation_status varchar(24) NOT NULL DEFAULT 'ACTIVE',
    created_at timestamptz NOT NULL DEFAULT now(),
    created_by uuid NOT NULL REFERENCES auth.users(id),
    effective_from timestamptz NOT NULL DEFAULT now(),
    effective_to timestamptz,
    CHECK (source_entity_id <> target_entity_id),
    CHECK (effective_to IS NULL OR effective_to > effective_from),
    CHECK (relation_status IN ('ACTIVE','SUPERSEDED','RETIRED')),
    UNIQUE (relation_id, source_entity_id, target_entity_id)
);

-- 5. RELATION REVISION
CREATE TABLE public.relation_revisions (
    relation_revision_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    relation_id uuid NOT NULL
        REFERENCES public.traceability_relations(relation_id),
    revision_no integer NOT NULL CHECK (revision_no > 0),
    relation_action varchar(24) NOT NULL,
    source_entity_revision_id uuid
        REFERENCES public.entity_revisions(entity_revision_id),
    target_entity_revision_id uuid
        REFERENCES public.entity_revisions(entity_revision_id),
    relation_payload jsonb NOT NULL,
    changed_at timestamptz NOT NULL DEFAULT now(),
    changed_by uuid NOT NULL REFERENCES auth.users(id),
    UNIQUE (relation_id, revision_no),
    CHECK (relation_action IN ('CREATE','UPDATE','RETIRE'))
);

-- 6. BASELINE MANIFEST
CREATE TABLE public.baseline_manifests (
    manifest_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    case_id uuid NOT NULL REFERENCES public.cases(case_id),
    manifest_purpose varchar(30) NOT NULL,
    manifest_status varchar(24) NOT NULL,
    frozen_at timestamptz,
    manifest_sha256 char(64),
    created_at timestamptz NOT NULL DEFAULT now(),
    created_by uuid NOT NULL REFERENCES auth.users(id),
    CHECK (manifest_purpose IN (
        'VALIDATION','ASSESSMENT','DOCUMENT','HANDOFF'
    )),
    CHECK (manifest_status IN ('DRAFT','FROZEN')),
    CHECK (
        (manifest_status = 'DRAFT' AND frozen_at IS NULL)
        OR
        (manifest_status = 'FROZEN'
         AND frozen_at IS NOT NULL
         AND manifest_sha256 IS NOT NULL)
    )
);

-- 7. MANIFEST ITEM
-- publication_id FK will be added after
-- document_publications is created.
CREATE TABLE public.manifest_items (
    manifest_item_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    manifest_id uuid NOT NULL
        REFERENCES public.baseline_manifests(manifest_id),
    item_kind varchar(28) NOT NULL,
    entity_revision_id uuid
        REFERENCES public.entity_revisions(entity_revision_id),
    relation_revision_id uuid
        REFERENCES public.relation_revisions(relation_revision_id),
    publication_id uuid,
    membership_role varchar(32) NOT NULL,
    sort_order integer NOT NULL CHECK (sort_order > 0),
    item_notes text,
    UNIQUE (manifest_id, sort_order),
    UNIQUE (manifest_id, manifest_item_id),
    CHECK (item_kind IN (
        'ENTITY_REVISION','RELATION_REVISION','PUBLICATION'
    )),
    CHECK (membership_role IN (
        'INCLUDED','REFERENCED_ONLY',
        'CONFIRMABLE','HANDOFF_ARTIFACT'
    )),
    CHECK (
        (
            item_kind = 'ENTITY_REVISION'
            AND entity_revision_id IS NOT NULL
            AND relation_revision_id IS NULL
            AND publication_id IS NULL
        )
        OR (
            item_kind = 'RELATION_REVISION'
            AND relation_revision_id IS NOT NULL
            AND entity_revision_id IS NULL
            AND publication_id IS NULL
        )
        OR (
            item_kind = 'PUBLICATION'
            AND publication_id IS NOT NULL
            AND entity_revision_id IS NULL
            AND relation_revision_id IS NULL
        )
    )
);

-- 8. VALIDATION RUN
CREATE TABLE public.validation_runs (
    validation_run_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    case_id uuid NOT NULL REFERENCES public.cases(case_id),
    manifest_id uuid NOT NULL
        REFERENCES public.baseline_manifests(manifest_id),
    policy_version_id uuid NOT NULL
        REFERENCES public.definition_versions(definition_version_id),
    run_status varchar(30) NOT NULL,
    started_at timestamptz NOT NULL,
    completed_at timestamptz,
    triggered_by uuid NOT NULL REFERENCES auth.users(id),
    execution_context jsonb,
    CHECK (run_status IN (
        'RUNNING','COMPLETED','FAILED_TO_RUN'
    )),
    CHECK (completed_at IS NULL OR completed_at >= started_at)
);

-- 9. VALIDATION RESULT
CREATE TABLE public.validation_results (
    validation_result_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    validation_run_id uuid NOT NULL
        REFERENCES public.validation_runs(validation_run_id),
    check_definition_version_id uuid NOT NULL
        REFERENCES public.definition_versions(definition_version_id),
    target_entity_revision_id uuid
        REFERENCES public.entity_revisions(entity_revision_id),
    result_outcome varchar(25) NOT NULL,
    execution_status varchar(30) NOT NULL,
    finding_summary text,
    severity varchar(20),
    ai_confidence numeric(5,4),
    result_details jsonb,
    evaluated_at timestamptz NOT NULL,
    CHECK (result_outcome IN (
        'PASS','FAIL','UNKNOWN','N_A','WARNING'
    )),
    CHECK (execution_status IN (
        'EXECUTED','FAILED_TO_RUN','NOT_EXECUTED'
    )),
    CHECK (ai_confidence IS NULL
        OR ai_confidence BETWEEN 0 AND 1)
);

-- 10. ASSESSMENT RECORD
CREATE TABLE public.assessment_records (
    assessment_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    case_id uuid NOT NULL REFERENCES public.cases(case_id),
    assessment_type varchar(30) NOT NULL,
    manifest_id uuid NOT NULL
        REFERENCES public.baseline_manifests(manifest_id),
    policy_version_id uuid NOT NULL
        REFERENCES public.definition_versions(definition_version_id),
    validation_run_id uuid
        REFERENCES public.validation_runs(validation_run_id),
    outcome varchar(35) NOT NULL,
    summary text,
    result_details jsonb,
    record_status varchar(25) NOT NULL DEFAULT 'DRAFT',
    assessed_at timestamptz NOT NULL,
    assessed_by uuid NOT NULL REFERENCES auth.users(id),
    CHECK (assessment_type IN (
        'COMPLETENESS','QUALITY','READINESS','IMPACT_REVIEW'
    )),
    CHECK (record_status IN ('DRAFT','FINALIZED'))
);

-- 11. AUDIT EVENT
CREATE TABLE public.audit_events (
    audit_event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    case_id uuid REFERENCES public.cases(case_id),
    event_type varchar(80) NOT NULL,
    actor_user_id uuid REFERENCES auth.users(id),
    actor_description varchar(120),
    target_entity_id uuid
        REFERENCES public.entity_identities(entity_id),
    target_revision_id uuid
        REFERENCES public.entity_revisions(entity_revision_id),
    related_record_type varchar(60),
    related_record_id uuid,
    event_payload jsonb NOT NULL,
    occurred_at timestamptz NOT NULL,
    recorded_at timestamptz NOT NULL DEFAULT now()
);

-- ADD PREVIOUSLY DEFERRED FOREIGN KEYS

ALTER TABLE public.module_applications
    ADD CONSTRAINT fk_module_definition
    FOREIGN KEY (module_definition_version_id)
    REFERENCES public.definition_versions(definition_version_id);

ALTER TABLE public.discovery_answers
    ADD CONSTRAINT fk_discovery_question_definition
    FOREIGN KEY (question_definition_version_id)
    REFERENCES public.definition_versions(definition_version_id);

ALTER TABLE public.discovery_answers
    ADD CONSTRAINT fk_discovery_source_identity
    FOREIGN KEY (source_entity_id)
    REFERENCES public.entity_identities(entity_id);

ALTER TABLE public.information_gaps
    ADD CONSTRAINT fk_gap_check_result
    FOREIGN KEY (check_result_id)
    REFERENCES public.validation_results(validation_result_id);

ALTER TABLE public.information_gaps
    ADD CONSTRAINT fk_gap_affected_entity
    FOREIGN KEY (affected_entity_id)
    REFERENCES public.entity_identities(entity_id);

ALTER TABLE public.evidence
    ADD CONSTRAINT fk_evidence_source_identity
    FOREIGN KEY (source_entity_id)
    REFERENCES public.entity_identities(entity_id);

ALTER TABLE public.evidence_review_records
    ADD CONSTRAINT fk_evidence_review_revision
    FOREIGN KEY (evidence_revision_id)
    REFERENCES public.entity_revisions(entity_revision_id);

ALTER TABLE public.evidence_confirmation_records
    ADD CONSTRAINT fk_evidence_confirmation_revision
    FOREIGN KEY (evidence_revision_id)
    REFERENCES public.entity_revisions(entity_revision_id);

ALTER TABLE public.issues
    ADD CONSTRAINT fk_issue_check_result
    FOREIGN KEY (source_check_result_id)
    REFERENCES public.validation_results(validation_result_id);

ALTER TABLE public.issue_resolutions
    ADD CONSTRAINT fk_issue_resolution_check
    FOREIGN KEY (verification_result_id)
    REFERENCES public.validation_results(validation_result_id);

ALTER TABLE public.form_question_items
    ADD CONSTRAINT fk_form_question_definition
    FOREIGN KEY (question_definition_version_id)
    REFERENCES public.definition_versions(definition_version_id);

ALTER TABLE public.authority_assignments
    ADD CONSTRAINT fk_authority_scope_identity
    FOREIGN KEY (scope_entity_id)
    REFERENCES public.entity_identities(entity_id);

-- INDEXES
CREATE INDEX idx_entity_revisions_lookup
    ON public.entity_revisions(entity_id, revision_no DESC);

CREATE INDEX idx_traceability_source
    ON public.traceability_relations(source_entity_id, relation_status);

CREATE INDEX idx_traceability_target
    ON public.traceability_relations(target_entity_id, relation_status);

CREATE INDEX idx_manifest_items_revision
    ON public.manifest_items(entity_revision_id);

CREATE INDEX idx_validation_runs_case
    ON public.validation_runs(case_id, started_at DESC);

CREATE INDEX idx_validation_results_run
    ON public.validation_results(validation_run_id);

CREATE INDEX idx_validation_results_target
    ON public.validation_results(target_entity_revision_id);

CREATE INDEX idx_assessments_case_type
    ON public.assessment_records(
        case_id, assessment_type, assessed_at DESC
    );

CREATE INDEX idx_audit_case_time
    ON public.audit_events(case_id, occurred_at DESC);

-- ENABLE RLS
ALTER TABLE public.entity_identities ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.entity_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.definition_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.traceability_relations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.relation_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.baseline_manifests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.manifest_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.validation_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.validation_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.assessment_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_events ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE
    public.entity_identities,
    public.entity_revisions,
    public.definition_versions,
    public.traceability_relations,
    public.relation_revisions,
    public.baseline_manifests,
    public.manifest_items,
    public.validation_runs,
    public.validation_results,
    public.assessment_records,
    public.audit_events
FROM anon, authenticated;

COMMIT;
