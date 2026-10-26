
-- REQUIREMENT TOOL V2
-- Repair migrations 002 & 003 against approved Data Dictionary
-- Does not modify the 3 Foundation tables

BEGIN;

-- SAFETY: abort if any affected table contains data
DO $$
DECLARE
    tbl text;
    has_rows boolean;
BEGIN
    FOREACH tbl IN ARRAY ARRAY[
        'stakeholders',
        'case_stakeholders',
        'role_assignments',
        'authority_assignments',
        'stakeholder_forms',
        'form_versions',
        'form_question_items',
        'form_responses',
        'form_answers',
        'public_access_grants'
    ]
    LOOP
        IF to_regclass('public.' || tbl) IS NULL THEN
            RAISE EXCEPTION 'Missing table: %', tbl;
        END IF;

        EXECUTE format(
            'SELECT EXISTS (SELECT 1 FROM public.%I)',
            tbl
        ) INTO has_rows;

        IF has_rows THEN
            RAISE EXCEPTION
                'Table % contains data. Repair aborted.', tbl;
        END IF;
    END LOOP;
END $$;

-- Drop only the 10 empty tables being repaired.
-- RESTRICT prevents removal if unexpected dependencies exist.
DROP TABLE public.form_answers RESTRICT;
DROP TABLE public.form_responses RESTRICT;
DROP TABLE public.public_access_grants RESTRICT;
DROP TABLE public.form_question_items RESTRICT;
DROP TABLE public.form_versions RESTRICT;
DROP TABLE public.stakeholder_forms RESTRICT;
DROP TABLE public.authority_assignments RESTRICT;
DROP TABLE public.role_assignments RESTRICT;
DROP TABLE public.case_stakeholders RESTRICT;
DROP TABLE public.stakeholders RESTRICT;

-- 1. STAKEHOLDER: 9 columns
CREATE TABLE public.stakeholders (
    stakeholder_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    external_reference varchar(100),
    display_name varchar(200) NOT NULL,
    organization varchar(200),
    contact_email varchar(255),
    contact_channel varchar(40),
    identity_status varchar(25) NOT NULL DEFAULT 'UNVERIFIED',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

-- 2. CASE STAKEHOLDER: 7 columns
CREATE TABLE public.case_stakeholders (
    case_stakeholder_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    case_id uuid NOT NULL REFERENCES public.cases(case_id),
    stakeholder_id uuid NOT NULL
        REFERENCES public.stakeholders(stakeholder_id),
    participation_status varchar(25) NOT NULL DEFAULT 'ACTIVE',
    joined_at timestamptz NOT NULL DEFAULT now(),
    ended_at timestamptz,
    notes text,
    UNIQUE (case_id, stakeholder_id)
);

-- 3. ROLE ASSIGNMENT: 7 columns
CREATE TABLE public.role_assignments (
    role_assignment_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    case_stakeholder_id uuid NOT NULL
        REFERENCES public.case_stakeholders(case_stakeholder_id),
    role_code varchar(80) NOT NULL,
    valid_from timestamptz NOT NULL DEFAULT now(),
    valid_to timestamptz,
    assigned_at timestamptz NOT NULL DEFAULT now(),
    assigned_by uuid NOT NULL REFERENCES auth.users(id),
    UNIQUE (role_assignment_id, case_stakeholder_id),
    CHECK (valid_to IS NULL OR valid_to > valid_from)
);

-- 4. AUTHORITY ASSIGNMENT: 11 columns
CREATE TABLE public.authority_assignments (
    authority_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    case_stakeholder_id uuid NOT NULL
        REFERENCES public.case_stakeholders(case_stakeholder_id),
    role_assignment_id uuid,
    authority_type varchar(50) NOT NULL,
    permitted_action varchar(70) NOT NULL,
    scope_entity_id uuid,
    scope_notes text,
    valid_from timestamptz NOT NULL,
    valid_to timestamptz,
    verification_status varchar(24) NOT NULL,
    verified_by uuid REFERENCES auth.users(id),

    FOREIGN KEY (role_assignment_id, case_stakeholder_id)
        REFERENCES public.role_assignments(
            role_assignment_id, case_stakeholder_id
        ),
    CHECK (valid_to IS NULL OR valid_to > valid_from)
);

-- 5. STAKEHOLDER FORM: 7 columns
CREATE TABLE public.stakeholder_forms (
    form_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    case_id uuid NOT NULL REFERENCES public.cases(case_id),
    form_name varchar(240) NOT NULL,
    form_purpose text,
    status varchar(24) NOT NULL DEFAULT 'DRAFT',
    created_by uuid NOT NULL REFERENCES auth.users(id),
    created_at timestamptz NOT NULL DEFAULT now()
);

-- 6. FORM VERSION: 7 columns
CREATE TABLE public.form_versions (
    form_version_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    form_id uuid NOT NULL
        REFERENCES public.stakeholder_forms(form_id),
    version_no integer NOT NULL CHECK (version_no > 0),
    publication_status varchar(24) NOT NULL DEFAULT 'DRAFT',
    content_hash varchar(64),
    published_at timestamptz,
    closed_at timestamptz,
    UNIQUE (form_id, version_no)
);

-- 7. FORM QUESTION ITEM: 10 columns
CREATE TABLE public.form_question_items (
    form_item_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    form_version_id uuid NOT NULL
        REFERENCES public.form_versions(form_version_id),
    question_definition_version_id uuid,
    item_key varchar(80) NOT NULL,
    prompt_label text NOT NULL,
    answer_type varchar(30) NOT NULL,
    required_flag boolean NOT NULL DEFAULT false,
    options_json jsonb,
    validation_json jsonb,
    sort_order integer NOT NULL,

    UNIQUE (form_version_id, item_key),
    UNIQUE (form_version_id, form_item_id)
);

-- 8. PUBLIC ACCESS GRANT: 9 columns
CREATE TABLE public.public_access_grants (
    grant_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    form_version_id uuid NOT NULL
        REFERENCES public.form_versions(form_version_id),
    stakeholder_id uuid
        REFERENCES public.stakeholders(stakeholder_id),
    token_hash varchar(128) NOT NULL UNIQUE,
    grant_scope varchar(32) NOT NULL DEFAULT 'SUBMIT',
    grant_status varchar(25) NOT NULL DEFAULT 'OPEN',
    expires_at timestamptz,
    revoked_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),

    UNIQUE (form_version_id, grant_id)
);

-- 9. FORM RESPONSE: 9 columns
CREATE TABLE public.form_responses (
    response_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    form_version_id uuid NOT NULL
        REFERENCES public.form_versions(form_version_id),
    case_id uuid NOT NULL REFERENCES public.cases(case_id),
    stakeholder_id uuid
        REFERENCES public.stakeholders(stakeholder_id),
    submitted_identity text,
    source_grant_id uuid,
    submitted_at timestamptz NOT NULL,
    review_status varchar(32) NOT NULL DEFAULT 'PENDING_BA_REVIEW',
    reviewed_at timestamptz,

    UNIQUE (response_id, form_version_id),

    FOREIGN KEY (form_version_id, source_grant_id)
        REFERENCES public.public_access_grants(
            form_version_id, grant_id
        )
);

-- 10. FORM ANSWER: 8 columns
CREATE TABLE public.form_answers (
    form_answer_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    response_id uuid NOT NULL,
    form_version_id uuid NOT NULL,
    form_item_id uuid NOT NULL,
    answer_value jsonb NOT NULL,
    answer_status varchar(32) NOT NULL DEFAULT 'SUBMITTED',
    answered_at timestamptz NOT NULL,
    review_note text,

    FOREIGN KEY (response_id, form_version_id)
        REFERENCES public.form_responses(
            response_id, form_version_id
        ),

    FOREIGN KEY (form_version_id, form_item_id)
        REFERENCES public.form_question_items(
            form_version_id, form_item_id
        ),

    UNIQUE (response_id, form_item_id)
);

-- Indexes for frequently used FK/query paths
CREATE INDEX idx_case_stakeholders_stakeholder
    ON public.case_stakeholders(stakeholder_id);

CREATE INDEX idx_roles_member
    ON public.role_assignments(case_stakeholder_id);

CREATE INDEX idx_authorities_member
    ON public.authority_assignments(case_stakeholder_id);

CREATE INDEX idx_forms_case
    ON public.stakeholder_forms(case_id);

CREATE INDEX idx_form_versions_form
    ON public.form_versions(form_id);

CREATE INDEX idx_form_items_version
    ON public.form_question_items(form_version_id);

CREATE INDEX idx_form_grants_version
    ON public.public_access_grants(form_version_id);

CREATE INDEX idx_form_responses_case
    ON public.form_responses(case_id);

CREATE INDEX idx_form_responses_stakeholder
    ON public.form_responses(stakeholder_id);

CREATE INDEX idx_form_answers_item
    ON public.form_answers(form_item_id);

-- Security: private by default
ALTER TABLE public.stakeholders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.case_stakeholders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.role_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.authority_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stakeholder_forms ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.form_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.form_question_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.public_access_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.form_responses ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.form_answers ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON
    public.stakeholders,
    public.case_stakeholders,
    public.role_assignments,
    public.authority_assignments,
    public.stakeholder_forms,
    public.form_versions,
    public.form_question_items,
    public.public_access_grants,
    public.form_responses,
    public.form_answers
FROM anon, authenticated;

COMMIT;
