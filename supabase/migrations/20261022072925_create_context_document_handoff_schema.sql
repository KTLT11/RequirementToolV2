
-- REQUIREMENT TOOL V2
-- MIGRATION: CONTEXT, DOCUMENTS & HANDOFF
-- Based on approved Data Dictionary (50 tables)

BEGIN;

-- ============================================
-- A. CASE & CONTEXT
-- ============================================

-- 1. BUSINESS CONTEXT: 9 columns
CREATE TABLE public.business_contexts (
    context_id uuid PRIMARY KEY
        REFERENCES public.entity_identities(entity_id),
    case_id uuid NOT NULL
        REFERENCES public.cases(case_id),
    context_type varchar(40) NOT NULL,
    content text NOT NULL,
    knowledge_status varchar(24) NOT NULL,
    source_entity_id uuid
        REFERENCES public.entity_identities(entity_id),
    current_revision_no integer NOT NULL DEFAULT 1,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),

    CHECK (current_revision_no >= 1),
    CHECK (length(btrim(content)) > 0),
    CHECK (knowledge_status IN (
        'KNOWN', 'UNKNOWN', 'ASSUMPTION'
    ))
);

-- 2. CASE SCOPE: 10 columns
CREATE TABLE public.case_scopes (
    scope_id uuid PRIMARY KEY
        REFERENCES public.entity_identities(entity_id),
    case_id uuid NOT NULL
        REFERENCES public.cases(case_id),
    scope_name varchar(180) NOT NULL,
    in_scope text NOT NULL,
    out_of_scope text,
    boundary_notes text,
    constraints_json jsonb NOT NULL DEFAULT '[]'::jsonb,
    current_revision_no integer NOT NULL DEFAULT 1,
    scope_status varchar(24) NOT NULL DEFAULT 'DRAFT',
    updated_at timestamptz NOT NULL DEFAULT now(),

    CHECK (current_revision_no >= 1),
    CHECK (jsonb_typeof(constraints_json) = 'array'),
    CHECK (length(btrim(scope_name)) > 0)
);

-- ============================================
-- G. DOCUMENTS & HANDOFF
-- ============================================

-- 3. DOCUMENT: 7 columns
CREATE TABLE public.documents (
    document_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    case_id uuid NOT NULL
        REFERENCES public.cases(case_id),
    document_type varchar(16) NOT NULL,
    document_name varchar(240) NOT NULL,
    document_status varchar(28) NOT NULL DEFAULT 'WORKING',
    created_at timestamptz NOT NULL DEFAULT now(),
    created_by uuid NOT NULL REFERENCES auth.users(id),

    CHECK (document_type IN ('CRD', 'DRD')),
    CHECK (document_status IN (
        'WORKING', 'ACTIVE', 'ARCHIVED'
    )),
    CHECK (length(btrim(document_name)) > 0)
);

-- 4. DOCUMENT SNAPSHOT: 10 columns
CREATE TABLE public.document_snapshots (
    snapshot_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id uuid NOT NULL
        REFERENCES public.documents(document_id),
    manifest_id uuid NOT NULL
        REFERENCES public.baseline_manifests(manifest_id),
    snapshot_version integer NOT NULL,
    storage_object_path text NOT NULL,
    content_sha256 char(64) NOT NULL,
    content_mime_type varchar(100) NOT NULL,
    rendered_at timestamptz NOT NULL,
    rendered_by uuid NOT NULL REFERENCES auth.users(id),
    render_status varchar(24) NOT NULL,

    UNIQUE (document_id, snapshot_version),
    UNIQUE (document_id, snapshot_id),
    UNIQUE (snapshot_id, manifest_id),

    CHECK (snapshot_version >= 1),
    CHECK (
        content_sha256 ~ '^[0-9a-fA-F]{64}$'
    ),
    CHECK (render_status IN (
        'FROZEN', 'INVALIDATED'
    ))
);

-- 5. DOCUMENT PUBLICATION: 10 columns
CREATE TABLE public.document_publications (
    publication_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id uuid NOT NULL
        REFERENCES public.documents(document_id),
    snapshot_id uuid NOT NULL,
    publication_version integer NOT NULL,
    publication_purpose varchar(35) NOT NULL,
    recipient_scope text NOT NULL,
    publication_status varchar(28) NOT NULL,
    published_at timestamptz NOT NULL,
    published_by uuid NOT NULL REFERENCES auth.users(id),
    transmission_reference text,

    UNIQUE (document_id, publication_version),
    UNIQUE (publication_id, snapshot_id),

    CONSTRAINT fk_publication_document_snapshot
        FOREIGN KEY (document_id, snapshot_id)
        REFERENCES public.document_snapshots(
            document_id, snapshot_id
        ),

    CHECK (publication_version >= 1),
    CHECK (publication_purpose IN (
        'CUSTOMER_REVIEW',
        'DEV_REVIEW',
        'HANDOFF'
    )),
    CHECK (publication_status IN (
        'PUBLISHED',
        'WITHDRAWN',
        'SUPERSEDED'
    ))
);

-- 6. CUSTOMER CONFIRMATION: 12 columns
CREATE TABLE public.customer_confirmations (
    confirmation_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    publication_id uuid NOT NULL,
    snapshot_id uuid NOT NULL,
    manifest_id uuid NOT NULL,
    signer_stakeholder_id uuid NOT NULL
        REFERENCES public.stakeholders(stakeholder_id),
    signer_authority_id uuid
        REFERENCES public.authority_assignments(authority_id),
    confirmation_outcome varchar(30) NOT NULL,
    confirmation_basis text NOT NULL,
    comments text,
    occurred_at timestamptz NOT NULL,
    recorded_at timestamptz NOT NULL DEFAULT now(),
    recorded_by uuid NOT NULL REFERENCES auth.users(id),

    UNIQUE (confirmation_id, manifest_id),

    CONSTRAINT fk_confirmation_publication_snapshot
        FOREIGN KEY (publication_id, snapshot_id)
        REFERENCES public.document_publications(
            publication_id, snapshot_id
        ),

    CONSTRAINT fk_confirmation_snapshot_manifest
        FOREIGN KEY (snapshot_id, manifest_id)
        REFERENCES public.document_snapshots(
            snapshot_id, manifest_id
        ),

    CHECK (confirmation_outcome IN (
        'CONFIRMED',
        'PARTIAL',
        'CHANGES_REQUESTED',
        'REJECTED'
    )),
    CHECK (length(btrim(confirmation_basis)) > 0)
);

-- 7. CONFIRMATION SCOPE ITEM: 6 columns
CREATE TABLE public.confirmation_scope_items (
    confirmation_scope_item_id uuid PRIMARY KEY
        DEFAULT gen_random_uuid(),
    confirmation_id uuid NOT NULL,
    manifest_id uuid NOT NULL,
    manifest_item_id uuid NOT NULL,
    unit_outcome varchar(32) NOT NULL,
    note text,

    UNIQUE (confirmation_id, manifest_item_id),

    CONSTRAINT fk_confirmation_item_parent
        FOREIGN KEY (confirmation_id, manifest_id)
        REFERENCES public.customer_confirmations(
            confirmation_id, manifest_id
        ),

    CONSTRAINT fk_confirmation_item_membership
        FOREIGN KEY (manifest_id, manifest_item_id)
        REFERENCES public.manifest_items(
            manifest_id, manifest_item_id
        ),

    CHECK (unit_outcome IN (
        'CONFIRMED',
        'NOT_CONFIRMED',
        'CHANGES_REQUESTED'
    ))
);

-- 8. HANDOFF BASELINE: 8 columns
CREATE TABLE public.handoff_baselines (
    handoff_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    case_id uuid NOT NULL REFERENCES public.cases(case_id),
    readiness_assessment_id uuid NOT NULL
        REFERENCES public.assessment_records(assessment_id),
    manifest_id uuid NOT NULL
        REFERENCES public.baseline_manifests(manifest_id),
    handoff_purpose varchar(40) NOT NULL,
    baseline_status varchar(28) NOT NULL,
    issued_at timestamptz NOT NULL,
    issued_by uuid NOT NULL REFERENCES auth.users(id),

    CHECK (handoff_purpose IN (
        'DEV_IMPLEMENTATION',
        'DEV_REVIEW'
    )),
    CHECK (baseline_status IN (
        'ISSUED',
        'WITHDRAWN',
        'SUPERSEDED'
    ))
);

-- 9. DEV REVIEW RECORD: 9 columns
CREATE TABLE public.dev_review_records (
    dev_review_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    handoff_id uuid NOT NULL
        REFERENCES public.handoff_baselines(handoff_id),
    reviewer_stakeholder_id uuid NOT NULL
        REFERENCES public.stakeholders(stakeholder_id),
    review_outcome varchar(32) NOT NULL,
    review_comments text,
    review_evidence_ref text,
    reviewed_at timestamptz,
    recorded_at timestamptz NOT NULL DEFAULT now(),
    recorded_by uuid NOT NULL REFERENCES auth.users(id),

    CHECK (review_outcome IN (
        'PENDING',
        'ACCEPTED',
        'ACCEPTED_WITH_BLOCKERS',
        'CHANGES_REQUESTED'
    )),
    CHECK (
        (review_outcome = 'PENDING'
         AND reviewed_at IS NULL)
        OR
        (review_outcome <> 'PENDING'
         AND reviewed_at IS NOT NULL)
    )
);

-- ============================================
-- RESOLVE PREVIOUSLY DEFERRED FK
-- ============================================

ALTER TABLE public.manifest_items
    ADD CONSTRAINT fk_manifest_item_publication
    FOREIGN KEY (publication_id)
    REFERENCES public.document_publications(publication_id);

-- ============================================
-- INDEXES
-- ============================================

CREATE INDEX idx_business_contexts_case
    ON public.business_contexts(case_id, context_type);

CREATE INDEX idx_case_scopes_case
    ON public.case_scopes(case_id);

CREATE INDEX idx_documents_case_type
    ON public.documents(case_id, document_type);

CREATE INDEX idx_snapshots_document
    ON public.document_snapshots(
        document_id, snapshot_version DESC
    );

CREATE INDEX idx_snapshots_manifest
    ON public.document_snapshots(manifest_id);

CREATE INDEX idx_publications_snapshot
    ON public.document_publications(snapshot_id);

CREATE INDEX idx_confirmations_publication
    ON public.customer_confirmations(publication_id);

CREATE INDEX idx_confirmation_items_manifest
    ON public.confirmation_scope_items(
        manifest_id, manifest_item_id
    );

CREATE INDEX idx_handoffs_case
    ON public.handoff_baselines(case_id, issued_at DESC);

CREATE INDEX idx_handoffs_readiness
    ON public.handoff_baselines(readiness_assessment_id);

CREATE INDEX idx_handoffs_manifest
    ON public.handoff_baselines(manifest_id);

CREATE INDEX idx_dev_reviews_handoff
    ON public.dev_review_records(handoff_id);

CREATE INDEX idx_manifest_items_publication
    ON public.manifest_items(publication_id);

-- ============================================
-- SECURITY
-- ============================================

ALTER TABLE public.business_contexts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.case_scopes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.document_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.document_publications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.customer_confirmations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.confirmation_scope_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.handoff_baselines ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.dev_review_records ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE
    public.business_contexts,
    public.case_scopes,
    public.documents,
    public.document_snapshots,
    public.document_publications,
    public.customer_confirmations,
    public.confirmation_scope_items,
    public.handoff_baselines,
    public.dev_review_records
FROM anon, authenticated;

COMMIT;
