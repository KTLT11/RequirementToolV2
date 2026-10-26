
BEGIN;

-- 1. Missing UNIQUE constraints

ALTER TABLE public.stakeholder_forms
    ADD CONSTRAINT uq_stakeholder_form_case_name
    UNIQUE (case_id, form_name);

ALTER TABLE public.form_question_items
    ADD CONSTRAINT uq_form_question_sort_order
    UNIQUE (form_version_id, sort_order);

-- 2. Composite key required for Evidence revision integrity

ALTER TABLE public.entity_revisions
    ADD CONSTRAINT uq_entity_revision_entity_pair
    UNIQUE (entity_id, entity_revision_id);

ALTER TABLE public.evidence_review_records
    ADD CONSTRAINT fk_evidence_review_correct_revision
    FOREIGN KEY (evidence_id, evidence_revision_id)
    REFERENCES public.entity_revisions(
        entity_id, entity_revision_id
    );

ALTER TABLE public.evidence_confirmation_records
    ADD CONSTRAINT fk_evidence_confirmation_correct_revision
    FOREIGN KEY (evidence_id, evidence_revision_id)
    REFERENCES public.entity_revisions(
        entity_id, entity_revision_id
    );

-- 3. Public access grant consistency

ALTER TABLE public.public_access_grants
    ADD CONSTRAINT chk_public_grant_revocation
    CHECK (
        revoked_at IS NULL
        OR grant_status = 'REVOKED'
    );

COMMIT;
