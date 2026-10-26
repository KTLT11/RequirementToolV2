
-- =====================================================
-- REQUIREMENT TOOL V2
-- MIGRATION 004: DISCOVERY MANAGEMENT
-- Source: Approved 50-table Data Dictionary
-- =====================================================

BEGIN;

-- ==========================================
-- 1. MODULE APPLICATION - 7 columns
-- ==========================================

CREATE TABLE public.module_applications (
    module_application_id UUID PRIMARY KEY
        DEFAULT gen_random_uuid(),

    case_id UUID NOT NULL
        REFERENCES public.cases(case_id)
        ON DELETE RESTRICT,

    module_definition_version_id UUID NOT NULL,

    application_status VARCHAR(30) NOT NULL
        DEFAULT 'ACTIVE',

    reason TEXT,

    started_at TIMESTAMPTZ NOT NULL
        DEFAULT now(),

    completed_at TIMESTAMPTZ,

    CONSTRAINT chk_module_application_status
        CHECK (
            application_status IN (
                'ACTIVE',
                'COMPLETED',
                'REMOVED'
            )
        ),

    CONSTRAINT chk_module_completion_time
        CHECK (
            completed_at IS NULL
            OR completed_at >= started_at
        )
);

-- ==========================================
-- 2. DISCOVERY ANSWER - 10 columns
-- ==========================================

CREATE TABLE public.discovery_answers (
    answer_id UUID PRIMARY KEY
        DEFAULT gen_random_uuid(),

    case_id UUID NOT NULL
        REFERENCES public.cases(case_id)
        ON DELETE RESTRICT,

    module_application_id UUID
        REFERENCES public.module_applications(
            module_application_id
        ) ON DELETE RESTRICT,

    question_definition_version_id UUID NOT NULL,

    answer_text TEXT,

    answer_status VARCHAR(25) NOT NULL,

    source_entity_id UUID,

    current_revision_no INTEGER NOT NULL
        DEFAULT 1,

    recorded_by UUID NOT NULL
        REFERENCES auth.users(id)
        ON DELETE RESTRICT,

    recorded_at TIMESTAMPTZ NOT NULL
        DEFAULT now(),

    CONSTRAINT chk_discovery_answer_status
        CHECK (
            answer_status IN (
                'KNOWN',
                'UNKNOWN',
                'ASSUMPTION',
                'N_A'
            )
        ),

    CONSTRAINT chk_discovery_revision
        CHECK (current_revision_no >= 1)
);

-- ==========================================
-- 3. INFORMATION GAP - 10 columns
-- ==========================================

CREATE TABLE public.information_gaps (
    gap_id UUID PRIMARY KEY
        DEFAULT gen_random_uuid(),

    case_id UUID NOT NULL
        REFERENCES public.cases(case_id)
        ON DELETE RESTRICT,

    condition_type VARCHAR(28) NOT NULL,

    required_information_key VARCHAR(100),

    check_result_id UUID,

    affected_entity_id UUID,

    gap_summary TEXT NOT NULL,

    gap_status VARCHAR(25) NOT NULL
        DEFAULT 'OPEN',

    created_at TIMESTAMPTZ NOT NULL
        DEFAULT now(),

    resolved_at TIMESTAMPTZ,

    CONSTRAINT chk_gap_condition_type
        CHECK (
            condition_type IN (
                'MISSING',
                'UNKNOWN',
                'AMBIGUITY',
                'CONFLICT',
                'DEPENDENCY'
            )
        ),

    CONSTRAINT chk_gap_status
        CHECK (
            gap_status IN (
                'OPEN',
                'CLARIFYING',
                'RESOLVED'
            )
        ),

    CONSTRAINT chk_gap_resolved_time
        CHECK (
            resolved_at IS NULL
            OR resolved_at >= created_at
        )
);

-- ==========================================
-- 4. INDEXES
-- ==========================================

CREATE INDEX idx_module_applications_case
    ON public.module_applications(case_id);

CREATE INDEX idx_discovery_answers_case
    ON public.discovery_answers(case_id);

CREATE INDEX idx_discovery_answers_module
    ON public.discovery_answers(
        module_application_id
    );

CREATE INDEX idx_information_gaps_case_status
    ON public.information_gaps(
        case_id,
        gap_status
    );

-- ==========================================
-- 5. SECURITY
-- ==========================================

ALTER TABLE public.module_applications
    ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.discovery_answers
    ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.information_gaps
    ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE
    public.module_applications,
    public.discovery_answers,
    public.information_gaps
FROM anon, authenticated;

COMMIT;
