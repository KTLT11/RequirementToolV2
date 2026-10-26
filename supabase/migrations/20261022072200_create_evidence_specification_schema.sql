
-- REQUIREMENT TOOL V2
-- Evidence, Issues & Specification
-- Source: approved 50-table Data Dictionary

BEGIN;

-- ============================================
-- D. EVIDENCE AND ISSUES
-- ============================================

CREATE TABLE public.evidence (
    evidence_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    case_id uuid NOT NULL REFERENCES public.cases(case_id),
    assertion_text text NOT NULL,
    source_kind varchar(40) NOT NULL,
    source_entity_id uuid,
    external_source_ref text,
    evidence_status varchar(30) NOT NULL DEFAULT 'UNCONFIRMED',
    review_status varchar(30) NOT NULL DEFAULT 'PENDING_REVIEW',
    current_revision_no integer NOT NULL DEFAULT 1,
    created_at timestamptz NOT NULL DEFAULT now(),
    CHECK (current_revision_no > 0)
);

CREATE TABLE public.evidence_review_records (
    evidence_review_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    evidence_id uuid NOT NULL
        REFERENCES public.evidence(evidence_id),
    evidence_revision_id uuid NOT NULL,
    reviewer_user_id uuid NOT NULL
        REFERENCES auth.users(id),
    review_outcome varchar(32) NOT NULL,
    review_basis text NOT NULL,
    reviewed_at timestamptz NOT NULL
);

CREATE TABLE public.evidence_confirmation_records (
    evidence_confirmation_id uuid PRIMARY KEY
        DEFAULT gen_random_uuid(),
    evidence_id uuid NOT NULL
        REFERENCES public.evidence(evidence_id),
    evidence_revision_id uuid NOT NULL,
    authority_id uuid
        REFERENCES public.authority_assignments(authority_id),
    confirming_stakeholder_id uuid
        REFERENCES public.stakeholders(stakeholder_id),
    confirmation_outcome varchar(28) NOT NULL,
    evidence_basis text NOT NULL,
    authority_snapshot jsonb,
    occurred_at timestamptz NOT NULL,
    recorded_at timestamptz NOT NULL DEFAULT now(),
    recorded_by uuid NOT NULL
        REFERENCES auth.users(id)
);

CREATE TABLE public.business_decisions (
    decision_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    case_id uuid NOT NULL REFERENCES public.cases(case_id),
    decision_subject varchar(240) NOT NULL,
    decision_text text NOT NULL,
    decision_outcome varchar(30) NOT NULL,
    authority_id uuid
        REFERENCES public.authority_assignments(authority_id),
    source_evidence_id uuid
        REFERENCES public.evidence(evidence_id),
    current_revision_no integer NOT NULL DEFAULT 1,
    effective_from timestamptz,
    effective_to timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    CHECK (current_revision_no > 0),
    CHECK (
        effective_to IS NULL
        OR effective_from IS NULL
        OR effective_to > effective_from
    )
);

CREATE TABLE public.issues (
    issue_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    case_id uuid NOT NULL REFERENCES public.cases(case_id),
    issue_code varchar(40) NOT NULL,
    issue_subject varchar(280) NOT NULL,
    issue_type varchar(30) NOT NULL,
    issue_status varchar(30) NOT NULL DEFAULT 'OPEN',
    severity varchar(20),
    assignee_user_id uuid REFERENCES auth.users(id),
    source_check_result_id uuid,
    current_revision_no integer NOT NULL DEFAULT 1,
    opened_at timestamptz NOT NULL DEFAULT now(),
    closed_at timestamptz,
    UNIQUE (case_id, issue_code),
    CHECK (current_revision_no > 0),
    CHECK (closed_at IS NULL OR closed_at >= opened_at)
);

CREATE TABLE public.issue_resolutions (
    resolution_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    issue_id uuid NOT NULL REFERENCES public.issues(issue_id),
    resolution_method varchar(50) NOT NULL,
    resolution_summary text NOT NULL,
    verification_outcome varchar(25) NOT NULL,
    verification_result_id uuid,
    resolution_evidence_id uuid
        REFERENCES public.evidence(evidence_id),
    resolution_decision_id uuid
        REFERENCES public.business_decisions(decision_id),
    verified_at timestamptz NOT NULL,
    verified_by uuid NOT NULL REFERENCES auth.users(id)
);

-- ============================================
-- E. REQUIREMENTS AND SPECIFICATION
-- ============================================

CREATE TABLE public.requirements (
    requirement_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    case_id uuid NOT NULL REFERENCES public.cases(case_id),
    requirement_code varchar(50) NOT NULL,
    requirement_type varchar(35) NOT NULL,
    title varchar(280) NOT NULL,
    statement text NOT NULL,
    rationale text,
    lifecycle_status varchar(30) NOT NULL DEFAULT 'DRAFT',
    priority varchar(20),
    current_revision_no integer NOT NULL DEFAULT 1,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (case_id, requirement_code),
    CHECK (current_revision_no > 0)
);

CREATE TABLE public.acceptance_criteria (
    ac_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    requirement_id uuid NOT NULL
        REFERENCES public.requirements(requirement_id),
    ac_code varchar(45) NOT NULL,
    condition_text text NOT NULL,
    expected_outcome text NOT NULL,
    verification_method varchar(40),
    status varchar(28) NOT NULL DEFAULT 'DRAFT',
    current_revision_no integer NOT NULL DEFAULT 1,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (requirement_id, ac_code),
    CHECK (current_revision_no > 0)
);

CREATE TABLE public.business_rules (
    rule_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    case_id uuid NOT NULL REFERENCES public.cases(case_id),
    rule_code varchar(50) NOT NULL,
    rule_statement text NOT NULL,
    rule_type varchar(35) NOT NULL,
    status varchar(30) NOT NULL DEFAULT 'DRAFT',
    current_revision_no integer NOT NULL DEFAULT 1,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (case_id, rule_code),
    CHECK (current_revision_no > 0)
);

CREATE TABLE public.workflow_scenarios (
    workflow_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    case_id uuid NOT NULL REFERENCES public.cases(case_id),
    workflow_code varchar(50) NOT NULL,
    workflow_name varchar(240) NOT NULL,
    trigger_description text,
    scenario_status varchar(30) NOT NULL DEFAULT 'DRAFT',
    current_revision_no integer NOT NULL DEFAULT 1,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (case_id, workflow_code),
    CHECK (current_revision_no > 0)
);

CREATE TABLE public.workflow_steps (
    step_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workflow_id uuid NOT NULL
        REFERENCES public.workflow_scenarios(workflow_id),
    step_key varchar(70) NOT NULL,
    step_name varchar(220) NOT NULL,
    step_type varchar(32) NOT NULL,
    step_description text,
    actor_role_code varchar(70),
    sort_order integer,
    current_revision_no integer NOT NULL DEFAULT 1,
    UNIQUE (workflow_id, step_key),
    UNIQUE (workflow_id, step_id),
    CHECK (current_revision_no > 0)
);

CREATE TABLE public.workflow_transitions (
    transition_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workflow_id uuid NOT NULL
        REFERENCES public.workflow_scenarios(workflow_id),
    source_step_id uuid NOT NULL,
    target_step_id uuid NOT NULL,
    transition_key varchar(80) NOT NULL,
    transition_condition text,
    action_outcome text,
    current_revision_no integer NOT NULL DEFAULT 1,

    UNIQUE (workflow_id, transition_key),

    FOREIGN KEY (workflow_id, source_step_id)
        REFERENCES public.workflow_steps(workflow_id, step_id),

    FOREIGN KEY (workflow_id, target_step_id)
        REFERENCES public.workflow_steps(workflow_id, step_id),

    CHECK (current_revision_no > 0)
);

CREATE TABLE public.business_data_definitions (
    data_definition_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    case_id uuid NOT NULL REFERENCES public.cases(case_id),
    data_code varchar(60) NOT NULL,
    entity_name varchar(220) NOT NULL,
    business_meaning text NOT NULL,
    data_kind varchar(35) NOT NULL,
    status varchar(28) NOT NULL DEFAULT 'DRAFT',
    current_revision_no integer NOT NULL DEFAULT 1,
    UNIQUE (case_id, data_code),
    CHECK (current_revision_no > 0)
);

CREATE TABLE public.business_data_attributes (
    attribute_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    data_definition_id uuid NOT NULL
        REFERENCES public.business_data_definitions(data_definition_id),
    attribute_code varchar(65) NOT NULL,
    attribute_name varchar(180) NOT NULL,
    business_type varchar(60) NOT NULL,
    nullable_policy varchar(26) NOT NULL,
    value_constraints jsonb,
    business_description text,
    current_revision_no integer NOT NULL DEFAULT 1,
    UNIQUE (data_definition_id, attribute_code),
    CHECK (current_revision_no > 0)
);

-- ============================================
-- INDEXES
-- ============================================

CREATE INDEX idx_evidence_case
    ON public.evidence(case_id);

CREATE INDEX idx_evidence_reviews_evidence
    ON public.evidence_review_records(evidence_id);

CREATE INDEX idx_evidence_confirmations_evidence
    ON public.evidence_confirmation_records(evidence_id);

CREATE INDEX idx_decisions_case
    ON public.business_decisions(case_id);

CREATE INDEX idx_issues_case_status
    ON public.issues(case_id, issue_status);

CREATE INDEX idx_resolutions_issue
    ON public.issue_resolutions(issue_id);

CREATE INDEX idx_requirements_case
    ON public.requirements(case_id);

CREATE INDEX idx_ac_requirement
    ON public.acceptance_criteria(requirement_id);

CREATE INDEX idx_rules_case
    ON public.business_rules(case_id);

CREATE INDEX idx_workflows_case
    ON public.workflow_scenarios(case_id);

CREATE INDEX idx_steps_workflow
    ON public.workflow_steps(workflow_id);

CREATE INDEX idx_transitions_target
    ON public.workflow_transitions(target_step_id);

CREATE INDEX idx_data_definitions_case
    ON public.business_data_definitions(case_id);

CREATE INDEX idx_data_attributes_definition
    ON public.business_data_attributes(data_definition_id);

-- ============================================
-- SECURITY: PRIVATE BY DEFAULT
-- ============================================

ALTER TABLE public.evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.evidence_review_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.evidence_confirmation_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.business_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.issues ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.issue_resolutions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.requirements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.acceptance_criteria ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.business_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workflow_scenarios ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workflow_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workflow_transitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.business_data_definitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.business_data_attributes ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE
    public.evidence,
    public.evidence_review_records,
    public.evidence_confirmation_records,
    public.business_decisions,
    public.issues,
    public.issue_resolutions,
    public.requirements,
    public.acceptance_criteria,
    public.business_rules,
    public.workflow_scenarios,
    public.workflow_steps,
    public.workflow_transitions,
    public.business_data_definitions,
    public.business_data_attributes
FROM anon, authenticated;

COMMIT;
