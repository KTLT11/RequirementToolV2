
-- =====================================================
-- MIGRATION 002: STAKEHOLDER & AUTHORITY
-- Requirement Tool V2
-- =====================================================

-- 1. Shared stakeholder profiles
CREATE TABLE public.stakeholders (
    stakeholder_id UUID PRIMARY KEY
        DEFAULT gen_random_uuid(),

    display_name VARCHAR(240) NOT NULL,
    email VARCHAR(320),
    phone VARCHAR(50),
    organization VARCHAR(240),
    job_title VARCHAR(160),
    stakeholder_type VARCHAR(40),
    notes TEXT,

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT chk_stakeholder_name
        CHECK (length(btrim(display_name)) > 0)
);

-- 2. Stakeholder participation in a Case
CREATE TABLE public.case_stakeholders (
    case_stakeholder_id UUID PRIMARY KEY
        DEFAULT gen_random_uuid(),

    case_id UUID NOT NULL
        REFERENCES public.cases(case_id)
        ON DELETE RESTRICT,

    stakeholder_id UUID NOT NULL
        REFERENCES public.stakeholders(stakeholder_id)
        ON DELETE RESTRICT,

    participation_status VARCHAR(32) NOT NULL
        DEFAULT 'ACTIVE',

    joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    left_at TIMESTAMPTZ,

    CONSTRAINT uq_case_stakeholder
        UNIQUE (case_id, stakeholder_id),

    CONSTRAINT chk_participation_status
        CHECK (
            participation_status IN (
                'ACTIVE', 'INACTIVE'
            )
        ),

    CONSTRAINT chk_participation_dates
        CHECK (
            left_at IS NULL OR left_at >= joined_at
        )
);

-- 3. Roles scoped to Case participation
CREATE TABLE public.role_assignments (
    role_assignment_id UUID PRIMARY KEY
        DEFAULT gen_random_uuid(),

    case_stakeholder_id UUID NOT NULL
        REFERENCES public.case_stakeholders(case_stakeholder_id)
        ON DELETE RESTRICT,

    role_code VARCHAR(80) NOT NULL,
    role_description TEXT,

    valid_from TIMESTAMPTZ NOT NULL DEFAULT now(),
    valid_until TIMESTAMPTZ,

    assigned_by UUID REFERENCES auth.users(id)
        ON DELETE RESTRICT,

    CONSTRAINT chk_role_code
        CHECK (length(btrim(role_code)) > 0),

    CONSTRAINT chk_role_dates
        CHECK (
            valid_until IS NULL
            OR valid_until > valid_from
        )
);

-- 4. Explicit scoped authority
CREATE TABLE public.authority_assignments (
    authority_assignment_id UUID PRIMARY KEY
        DEFAULT gen_random_uuid(),

    case_stakeholder_id UUID NOT NULL
        REFERENCES public.case_stakeholders(case_stakeholder_id)
        ON DELETE RESTRICT,

    authority_action VARCHAR(80) NOT NULL,

    scope_type VARCHAR(40) NOT NULL DEFAULT 'CASE',
    scope_entity_id UUID,

    authority_basis TEXT NOT NULL,

    valid_from TIMESTAMPTZ NOT NULL DEFAULT now(),
    valid_until TIMESTAMPTZ,

    granted_by UUID REFERENCES auth.users(id)
        ON DELETE RESTRICT,

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT chk_authority_action
        CHECK (length(btrim(authority_action)) > 0),

    CONSTRAINT chk_authority_scope
        CHECK (
            (scope_type = 'CASE' AND scope_entity_id IS NULL)
            OR
            (
                scope_type IN ('REQUIREMENT', 'DOCUMENT')
                AND scope_entity_id IS NOT NULL
            )
        ),

    CONSTRAINT chk_authority_basis
        CHECK (length(btrim(authority_basis)) > 0),

    CONSTRAINT chk_authority_dates
        CHECK (
            valid_until IS NULL
            OR valid_until > valid_from
        )
);

-- 5. Query indexes
CREATE INDEX idx_case_stakeholders_stakeholder
    ON public.case_stakeholders(stakeholder_id);

CREATE INDEX idx_role_assignments_member
    ON public.role_assignments(
        case_stakeholder_id, role_code
    );

CREATE INDEX idx_authorities_member_action
    ON public.authority_assignments(
        case_stakeholder_id, authority_action
    );

CREATE INDEX idx_authorities_scope
    ON public.authority_assignments(
        scope_type, scope_entity_id
    );

-- 6. Security baseline
ALTER TABLE public.stakeholders
    ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.case_stakeholders
    ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.role_assignments
    ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.authority_assignments
    ENABLE ROW LEVEL SECURITY;
