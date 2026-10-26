
-- =========================================================
-- REQUIREMENT TOOL V2
-- Migration 001: Case & Incoming Request Foundation
-- PostgreSQL / Supabase Cloud
-- =========================================================

-- 1. CASE
CREATE TABLE public.cases (
    case_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    case_code VARCHAR(40) NOT NULL UNIQUE,
    case_name VARCHAR(240) NOT NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'IN_PROGRESS',
    primary_owner_user_id UUID NOT NULL
        REFERENCES auth.users(id) ON DELETE RESTRICT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    closed_at TIMESTAMPTZ,

    CONSTRAINT chk_case_name_not_empty
        CHECK (length(btrim(case_name)) > 0),

    CONSTRAINT chk_case_status_not_empty
        CHECK (length(btrim(status)) > 0)
);

-- 2. INCOMING REQUEST
CREATE TABLE public.incoming_requests (
    request_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    request_code VARCHAR(40) NOT NULL UNIQUE,
    request_text TEXT NOT NULL,
    source_type VARCHAR(40) NOT NULL,
    received_at TIMESTAMPTZ NOT NULL,
    recorded_by UUID NOT NULL
        REFERENCES auth.users(id) ON DELETE RESTRICT,
    source_reference TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT chk_request_text_not_empty
        CHECK (length(btrim(request_text)) > 0),

    CONSTRAINT chk_request_source_not_empty
        CHECK (length(btrim(source_type)) > 0)
);

-- 3. CASE - REQUEST ASSOCIATION
CREATE TABLE public.case_request_associations (
    case_request_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    case_id UUID NOT NULL
        REFERENCES public.cases(case_id) ON DELETE RESTRICT,
    request_id UUID NOT NULL
        REFERENCES public.incoming_requests(request_id)
        ON DELETE RESTRICT,
    relation_role VARCHAR(30) NOT NULL DEFAULT 'SOURCE',
    linked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    linked_by UUID NOT NULL
        REFERENCES auth.users(id) ON DELETE RESTRICT,
    unlinked_at TIMESTAMPTZ,

    CONSTRAINT uq_case_request
        UNIQUE (case_id, request_id),

    CONSTRAINT chk_case_request_role
        CHECK (
            relation_role IN (
                'PRIMARY',
                'SOURCE',
                'CROSS_REFERENCE'
            )
        ),

    CONSTRAINT chk_unlinked_after_linked
        CHECK (
            unlinked_at IS NULL
            OR unlinked_at >= linked_at
        )
);

-- 4. INDEXES
CREATE INDEX idx_cases_owner_status
    ON public.cases(primary_owner_user_id, status);

CREATE INDEX idx_requests_received_at
    ON public.incoming_requests(received_at DESC);

CREATE INDEX idx_case_requests_request
    ON public.case_request_associations(request_id);

-- 5. INITIAL SECURITY
-- RLS is enabled now. Policies will be added after
-- the access model and authenticated operations are ready.

ALTER TABLE public.cases
    ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.incoming_requests
    ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.case_request_associations
    ENABLE ROW LEVEL SECURITY;
