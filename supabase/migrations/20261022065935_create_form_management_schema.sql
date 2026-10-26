
-- ==================================================
-- REQUIREMENT TOOL V2
-- MIGRATION 003 - FORM MANAGEMENT
-- ==================================================

-- 1. STAKEHOLDER FORMS
CREATE TABLE public.stakeholder_forms (
    form_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    case_id UUID NOT NULL
        REFERENCES public.cases(case_id) ON DELETE RESTRICT,
    form_code VARCHAR(50) NOT NULL,
    title VARCHAR(255) NOT NULL,
    description TEXT,
    lifecycle_status VARCHAR(20) NOT NULL DEFAULT 'DRAFT',
    created_by UUID NOT NULL
        REFERENCES auth.users(id) ON DELETE RESTRICT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT uq_form_code_per_case UNIQUE (case_id, form_code),
    CONSTRAINT chk_form_title CHECK (length(btrim(title)) > 0),
    CONSTRAINT chk_form_status CHECK (
        lifecycle_status IN ('DRAFT', 'ACTIVE', 'ARCHIVED')
    )
);

-- 2. FORM VERSIONS
CREATE TABLE public.form_versions (
    form_version_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    form_id UUID NOT NULL
        REFERENCES public.stakeholder_forms(form_id)
        ON DELETE RESTRICT,
    version_no INTEGER NOT NULL CHECK (version_no > 0),
    title VARCHAR(255) NOT NULL,
    instructions TEXT,
    version_status VARCHAR(20) NOT NULL DEFAULT 'DRAFT',
    created_by UUID NOT NULL
        REFERENCES auth.users(id) ON DELETE RESTRICT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    published_at TIMESTAMPTZ,
    closed_at TIMESTAMPTZ,

    CONSTRAINT uq_form_version UNIQUE (form_id, version_no),
    CONSTRAINT chk_form_version_status CHECK (
        version_status IN ('DRAFT', 'OPEN', 'CLOSED', 'REVOKED')
    ),
    CONSTRAINT chk_form_published CHECK (
        version_status = 'DRAFT' OR published_at IS NOT NULL
    ),
    CONSTRAINT chk_form_closed_time CHECK (
        closed_at IS NULL OR published_at IS NULL
        OR closed_at >= published_at
    )
);

-- 3. FORM QUESTION ITEMS
CREATE TABLE public.form_question_items (
    question_item_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    form_version_id UUID NOT NULL
        REFERENCES public.form_versions(form_version_id)
        ON DELETE RESTRICT,
    question_code VARCHAR(60) NOT NULL,
    question_text TEXT NOT NULL,
    question_type VARCHAR(30) NOT NULL,
    is_required BOOLEAN NOT NULL DEFAULT FALSE,
    display_order INTEGER NOT NULL CHECK (display_order > 0),
    options_config JSONB,
    validation_config JSONB,
    required_information_ref TEXT,

    CONSTRAINT uq_form_question_code
        UNIQUE (form_version_id, question_code),
    CONSTRAINT uq_form_question_order
        UNIQUE (form_version_id, display_order),
    CONSTRAINT uq_question_version_pair
        UNIQUE (form_version_id, question_item_id),
    CONSTRAINT chk_question_text
        CHECK (length(btrim(question_text)) > 0),
    CONSTRAINT chk_question_type CHECK (
        question_type IN (
            'TEXT', 'LONG_TEXT', 'NUMBER', 'DATE',
            'SINGLE_CHOICE', 'MULTIPLE_CHOICE',
            'BOOLEAN', 'FILE'
        )
    )
);

-- 4. FORM RESPONSES
CREATE TABLE public.form_responses (
    response_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    form_version_id UUID NOT NULL
        REFERENCES public.form_versions(form_version_id)
        ON DELETE RESTRICT,
    stakeholder_id UUID
        REFERENCES public.stakeholders(stakeholder_id)
        ON DELETE RESTRICT,
    submitted_identity JSONB,
    review_status VARCHAR(30) NOT NULL DEFAULT 'PENDING_BA_REVIEW',
    submitted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    reviewed_by UUID REFERENCES auth.users(id)
        ON DELETE RESTRICT,
    reviewed_at TIMESTAMPTZ,

    CONSTRAINT uq_response_version_pair
        UNIQUE (response_id, form_version_id),
    CONSTRAINT chk_response_review_status CHECK (
        review_status IN (
            'PENDING_BA_REVIEW', 'REVIEWED',
            'NEEDS_CLARIFICATION', 'CONFLICT'
        )
    ),
    CONSTRAINT chk_response_review_metadata CHECK (
        (review_status = 'PENDING_BA_REVIEW'
            AND reviewed_at IS NULL AND reviewed_by IS NULL)
        OR
        (review_status <> 'PENDING_BA_REVIEW'
            AND reviewed_at IS NOT NULL AND reviewed_by IS NOT NULL)
    )
);

-- 5. FORM ANSWERS
CREATE TABLE public.form_answers (
    answer_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    response_id UUID NOT NULL,
    form_version_id UUID NOT NULL,
    question_item_id UUID NOT NULL,
    answer_value JSONB,
    answered_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT fk_answer_response_version
        FOREIGN KEY (response_id, form_version_id)
        REFERENCES public.form_responses(
            response_id, form_version_id
        ) ON DELETE RESTRICT,

    CONSTRAINT fk_answer_question_version
        FOREIGN KEY (form_version_id, question_item_id)
        REFERENCES public.form_question_items(
            form_version_id, question_item_id
        ) ON DELETE RESTRICT,

    CONSTRAINT uq_one_answer_per_question
        UNIQUE (response_id, question_item_id)
);

-- 6. PUBLIC ACCESS GRANTS
CREATE TABLE public.public_access_grants (
    access_grant_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    form_version_id UUID NOT NULL
        REFERENCES public.form_versions(form_version_id)
        ON DELETE RESTRICT,
    token_hash TEXT NOT NULL UNIQUE,
    grant_status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
    expires_at TIMESTAMPTZ,
    max_submissions INTEGER CHECK (
        max_submissions IS NULL OR max_submissions > 0
    ),
    submissions_used INTEGER NOT NULL DEFAULT 0
        CHECK (submissions_used >= 0),
    created_by UUID NOT NULL
        REFERENCES auth.users(id) ON DELETE RESTRICT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    revoked_at TIMESTAMPTZ,

    CONSTRAINT chk_access_grant_status CHECK (
        grant_status IN ('ACTIVE', 'REVOKED')
    ),
    CONSTRAINT chk_access_grant_revocation CHECK (
        (grant_status = 'ACTIVE' AND revoked_at IS NULL)
        OR
        (grant_status = 'REVOKED' AND revoked_at IS NOT NULL)
    ),
    CONSTRAINT chk_access_grant_limit CHECK (
        max_submissions IS NULL
        OR submissions_used <= max_submissions
    )
);

-- 7. INDEXES
CREATE INDEX idx_forms_case
    ON public.stakeholder_forms(case_id);

CREATE INDEX idx_form_versions_form
    ON public.form_versions(form_id, version_no DESC);

CREATE INDEX idx_form_responses_version
    ON public.form_responses(
        form_version_id, submitted_at DESC
    );

CREATE INDEX idx_form_responses_review
    ON public.form_responses(
        review_status, submitted_at DESC
    );

CREATE INDEX idx_form_answers_question
    ON public.form_answers(question_item_id);

CREATE INDEX idx_public_grants_version
    ON public.public_access_grants(form_version_id);

-- 8. SECURITY
ALTER TABLE public.stakeholder_forms
    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.form_versions
    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.form_question_items
    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.form_responses
    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.form_answers
    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.public_access_grants
    ENABLE ROW LEVEL SECURITY;

-- No browser access to form tables until policies
-- and controlled submission endpoints are implemented.
REVOKE ALL ON TABLE
    public.stakeholder_forms,
    public.form_versions,
    public.form_question_items,
    public.form_responses,
    public.form_answers,
    public.public_access_grants
FROM anon, authenticated;
