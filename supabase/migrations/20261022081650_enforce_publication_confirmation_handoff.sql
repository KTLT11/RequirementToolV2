
-- ============================================================
-- REQUIREMENT TOOL V2
-- BUSINESS INTEGRITY: PUBLICATION, CONFIRMATION & HANDOFF
-- No new tables, no data deletion
-- ============================================================

BEGIN;

-- ============================================================
-- 1. ASSESSMENT TYPE / OUTCOME
-- ============================================================

ALTER TABLE public.assessment_records
ADD CONSTRAINT chk_assessment_type_outcome
CHECK (
    (
        assessment_type = 'READINESS'
        AND outcome IN (
            'READY', 'READY_BUT_BLOCKED', 'NOT_READY'
        )
    )
    OR (
        assessment_type = 'COMPLETENESS'
        AND outcome IN (
            'COMPLETE', 'INCOMPLETE', 'UNKNOWN'
        )
    )
    OR (
        assessment_type = 'QUALITY'
        AND outcome IN (
            'PASS', 'FAIL', 'UNKNOWN'
        )
    )
    OR (
        assessment_type = 'IMPACT_REVIEW'
        AND outcome IN (
            'REVIEWED', 'REVIEW_REQUIRED', 'UNKNOWN'
        )
    )
);

-- ============================================================
-- 2. FINALIZED ASSESSMENT IMMUTABILITY
-- ============================================================

CREATE OR REPLACE FUNCTION public.rt_protect_final_assessment()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
    IF OLD.record_status = 'FINALIZED' THEN
        RAISE EXCEPTION
            'Finalized assessment cannot be modified or deleted';
    END IF;

    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;

    IF NEW.record_status = 'FINALIZED' THEN
        IF NOT EXISTS (
            SELECT 1
            FROM public.baseline_manifests bm
            WHERE bm.manifest_id = NEW.manifest_id
              AND bm.case_id = NEW.case_id
              AND bm.manifest_status = 'FROZEN'
        ) THEN
            RAISE EXCEPTION
                'Finalized assessment requires a frozen manifest of the same Case';
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER rt_final_assessment_guard
BEFORE UPDATE OR DELETE
ON public.assessment_records
FOR EACH ROW
EXECUTE FUNCTION public.rt_protect_final_assessment();


-- ============================================================
-- 3. DOCUMENT SNAPSHOT IMMUTABILITY
-- ============================================================

CREATE OR REPLACE FUNCTION public.rt_protect_document_snapshot()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION
            'Document snapshots cannot be deleted';
    END IF;

    IF ROW(
        NEW.snapshot_id,
        NEW.document_id,
        NEW.manifest_id,
        NEW.snapshot_version,
        NEW.storage_object_path,
        NEW.content_sha256,
        NEW.content_mime_type,
        NEW.rendered_at,
        NEW.rendered_by
    ) IS DISTINCT FROM ROW(
        OLD.snapshot_id,
        OLD.document_id,
        OLD.manifest_id,
        OLD.snapshot_version,
        OLD.storage_object_path,
        OLD.content_sha256,
        OLD.content_mime_type,
        OLD.rendered_at,
        OLD.rendered_by
    ) THEN
        RAISE EXCEPTION
            'Document snapshot content is immutable';
    END IF;

    IF NEW.render_status IS DISTINCT FROM OLD.render_status
       AND NOT (
           OLD.render_status = 'FROZEN'
           AND NEW.render_status = 'INVALIDATED'
       )
    THEN
        RAISE EXCEPTION
            'Invalid document snapshot status transition';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER rt_document_snapshot_immutable
BEFORE UPDATE OR DELETE
ON public.document_snapshots
FOR EACH ROW
EXECUTE FUNCTION public.rt_protect_document_snapshot();


-- ============================================================
-- 4. SNAPSHOT MUST USE A FROZEN DOCUMENT MANIFEST
-- ============================================================

CREATE OR REPLACE FUNCTION public.rt_validate_snapshot_manifest()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
    v_status text;
    v_purpose text;
BEGIN
    SELECT
        bm.manifest_status,
        bm.manifest_purpose
    INTO
        v_status,
        v_purpose
    FROM public.baseline_manifests bm
    WHERE bm.manifest_id = NEW.manifest_id
    FOR SHARE;

    IF NOT FOUND
       OR v_status IS DISTINCT FROM 'FROZEN'
       OR v_purpose IS DISTINCT FROM 'DOCUMENT'
    THEN
        RAISE EXCEPTION
            'Document snapshot requires a frozen DOCUMENT manifest';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER rt_snapshot_manifest_state
BEFORE INSERT
ON public.document_snapshots
FOR EACH ROW
EXECUTE FUNCTION public.rt_validate_snapshot_manifest();


-- ============================================================
-- 5. DOCUMENT PUBLICATION
-- ============================================================

CREATE OR REPLACE FUNCTION public.rt_guard_document_publication()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
    v_snapshot_status text;
    v_manifest_status text;
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION
            'Document publication history cannot be deleted';
    END IF;

    IF TG_OP = 'UPDATE' THEN

        IF ROW(
            NEW.publication_id,
            NEW.document_id,
            NEW.snapshot_id,
            NEW.publication_version,
            NEW.publication_purpose,
            NEW.recipient_scope,
            NEW.published_at,
            NEW.published_by,
            NEW.transmission_reference
        ) IS DISTINCT FROM ROW(
            OLD.publication_id,
            OLD.document_id,
            OLD.snapshot_id,
            OLD.publication_version,
            OLD.publication_purpose,
            OLD.recipient_scope,
            OLD.published_at,
            OLD.published_by,
            OLD.transmission_reference
        ) THEN
            RAISE EXCEPTION
                'Publication content cannot be changed';
        END IF;

        IF NEW.publication_status
           IS DISTINCT FROM OLD.publication_status
           AND NOT (
               OLD.publication_status = 'PUBLISHED'
               AND NEW.publication_status IN (
                   'WITHDRAWN', 'SUPERSEDED'
               )
           )
        THEN
            RAISE EXCEPTION
                'Invalid publication status transition';
        END IF;

        RETURN NEW;
    END IF;

    SELECT
        ds.render_status,
        bm.manifest_status
    INTO
        v_snapshot_status,
        v_manifest_status
    FROM public.document_snapshots ds
    JOIN public.baseline_manifests bm
        ON bm.manifest_id = ds.manifest_id
    WHERE ds.snapshot_id = NEW.snapshot_id
    FOR SHARE OF ds, bm;

    IF NOT FOUND
       OR v_snapshot_status IS DISTINCT FROM 'FROZEN'
       OR v_manifest_status IS DISTINCT FROM 'FROZEN'
    THEN
        RAISE EXCEPTION
            'Publication requires a frozen snapshot and manifest';
    END IF;

    IF NEW.publication_status IS DISTINCT FROM 'PUBLISHED' THEN
        RAISE EXCEPTION
            'New publication must start in PUBLISHED status';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER rt_document_publication_guard
BEFORE INSERT OR UPDATE OR DELETE
ON public.document_publications
FOR EACH ROW
EXECUTE FUNCTION public.rt_guard_document_publication();


-- ============================================================
-- 6. CUSTOMER CONFIRMATION
-- Only CRD publication may receive customer confirmation.
-- Confirmation history is immutable.
-- ============================================================

CREATE OR REPLACE FUNCTION public.rt_guard_customer_confirmation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
    v_case_id uuid;
    v_document_type text;
    v_publication_purpose text;
    v_publication_status text;
    v_snapshot_status text;
    v_published_at timestamptz;

    v_case_stakeholder_id uuid;
    v_authority_status text;
    v_permitted_action text;
    v_authority_from timestamptz;
    v_authority_to timestamptz;
BEGIN
    IF TG_OP <> 'INSERT' THEN
        RAISE EXCEPTION
            'Customer confirmation history is immutable';
    END IF;

    SELECT
        d.case_id,
        d.document_type,
        p.publication_purpose,
        p.publication_status,
        ds.render_status,
        p.published_at
    INTO
        v_case_id,
        v_document_type,
        v_publication_purpose,
        v_publication_status,
        v_snapshot_status,
        v_published_at
    FROM public.document_publications p
    JOIN public.documents d
        ON d.document_id = p.document_id
    JOIN public.document_snapshots ds
        ON ds.snapshot_id = p.snapshot_id
    WHERE p.publication_id = NEW.publication_id
    FOR SHARE OF p, d, ds;

    IF NOT FOUND
       OR v_document_type IS DISTINCT FROM 'CRD'
       OR v_publication_purpose IS DISTINCT FROM 'CUSTOMER_REVIEW'
       OR v_publication_status IS DISTINCT FROM 'PUBLISHED'
       OR v_snapshot_status IS DISTINCT FROM 'FROZEN'
    THEN
        RAISE EXCEPTION
            'Confirmation requires a published CRD review snapshot';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM public.baseline_manifests bm
        WHERE bm.manifest_id = NEW.manifest_id
          AND bm.case_id = v_case_id
          AND bm.manifest_status = 'FROZEN'
    ) THEN
        RAISE EXCEPTION
            'Confirmation requires a frozen manifest of the same Case';
    END IF;

    IF NEW.occurred_at < v_published_at THEN
        RAISE EXCEPTION
            'Confirmation cannot occur before publication';
    END IF;

    IF NEW.signer_authority_id IS NULL THEN
        RAISE EXCEPTION
            'Customer confirmation requires signer authority';
    END IF;

    SELECT
        a.case_stakeholder_id,
        a.verification_status,
        a.permitted_action,
        a.valid_from,
        a.valid_to
    INTO
        v_case_stakeholder_id,
        v_authority_status,
        v_permitted_action,
        v_authority_from,
        v_authority_to
    FROM public.authority_assignments a
    WHERE a.authority_id = NEW.signer_authority_id
    FOR SHARE;

    IF NOT FOUND THEN
        RAISE EXCEPTION
            'Signer authority does not exist';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM public.case_stakeholders cs
        WHERE cs.case_stakeholder_id = v_case_stakeholder_id
          AND cs.case_id = v_case_id
          AND cs.stakeholder_id = NEW.signer_stakeholder_id
          AND cs.joined_at <= NEW.occurred_at
          AND (
              cs.ended_at IS NULL
              OR NEW.occurred_at < cs.ended_at
          )
    ) THEN
        RAISE EXCEPTION
            'Signer authority does not match the Case stakeholder';
    END IF;

    IF v_authority_status IS DISTINCT FROM 'VERIFIED'
       OR v_permitted_action IS DISTINCT FROM 'CONFIRM'
       OR v_authority_from IS NULL
       OR NEW.occurred_at < v_authority_from
       OR (
           v_authority_to IS NOT NULL
           AND NEW.occurred_at >= v_authority_to
       )
    THEN
        RAISE EXCEPTION
            'Signer lacks valid verified confirmation authority';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER rt_customer_confirmation_guard
BEFORE INSERT OR UPDATE OR DELETE
ON public.customer_confirmations
FOR EACH ROW
EXECUTE FUNCTION public.rt_guard_customer_confirmation();


-- ============================================================
-- 7. CUSTOMER CONFIRMATION SCOPE
-- ============================================================

CREATE OR REPLACE FUNCTION public.rt_guard_confirmation_scope()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
    v_item_kind text;
    v_membership_role text;
    v_manifest_status text;
BEGIN
    IF TG_OP <> 'INSERT' THEN
        RAISE EXCEPTION
            'Confirmation scope history is immutable';
    END IF;

    SELECT
        mi.item_kind,
        mi.membership_role,
        bm.manifest_status
    INTO
        v_item_kind,
        v_membership_role,
        v_manifest_status
    FROM public.manifest_items mi
    JOIN public.baseline_manifests bm
        ON bm.manifest_id = mi.manifest_id
    WHERE mi.manifest_id = NEW.manifest_id
      AND mi.manifest_item_id = NEW.manifest_item_id
    FOR SHARE OF mi, bm;

    IF NOT FOUND
       OR v_item_kind IS DISTINCT FROM 'ENTITY_REVISION'
       OR v_membership_role IS DISTINCT FROM 'CONFIRMABLE'
       OR v_manifest_status IS DISTINCT FROM 'FROZEN'
    THEN
        RAISE EXCEPTION
            'Confirmation target must be a CONFIRMABLE revision in a frozen manifest';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER rt_confirmation_scope_guard
BEFORE INSERT OR UPDATE OR DELETE
ON public.confirmation_scope_items
FOR EACH ROW
EXECUTE FUNCTION public.rt_guard_confirmation_scope();


-- ============================================================
-- 8. HANDOFF BASELINE
-- Allow ISSUED -> WITHDRAWN / SUPERSEDED.
-- Preserve immutable handoff history.
-- ============================================================

CREATE OR REPLACE FUNCTION public.rt_guard_handoff()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
    v_assessment public.assessment_records%ROWTYPE;
    v_manifest public.baseline_manifests%ROWTYPE;
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION
            'Handoff history cannot be deleted';
    END IF;

    IF TG_OP = 'UPDATE' THEN

        IF ROW(
            NEW.handoff_id,
            NEW.case_id,
            NEW.readiness_assessment_id,
            NEW.manifest_id,
            NEW.handoff_purpose,
            NEW.issued_at,
            NEW.issued_by
        ) IS DISTINCT FROM ROW(
            OLD.handoff_id,
            OLD.case_id,
            OLD.readiness_assessment_id,
            OLD.manifest_id,
            OLD.handoff_purpose,
            OLD.issued_at,
            OLD.issued_by
        ) THEN
            RAISE EXCEPTION
                'Handoff baseline content is immutable';
        END IF;

        IF NEW.baseline_status
           IS DISTINCT FROM OLD.baseline_status
           AND NOT (
               OLD.baseline_status = 'ISSUED'
               AND NEW.baseline_status IN (
                   'WITHDRAWN', 'SUPERSEDED'
               )
           )
        THEN
            RAISE EXCEPTION
                'Invalid handoff status transition';
        END IF;

        RETURN NEW;
    END IF;

    SELECT *
    INTO v_assessment
    FROM public.assessment_records
    WHERE assessment_id = NEW.readiness_assessment_id
    FOR SHARE;

    IF NOT FOUND THEN
        RAISE EXCEPTION
            'Readiness assessment does not exist';
    END IF;

    SELECT *
    INTO v_manifest
    FROM public.baseline_manifests
    WHERE manifest_id = NEW.manifest_id
    FOR SHARE;

    IF NOT FOUND THEN
        RAISE EXCEPTION
            'Handoff manifest does not exist';
    END IF;

    IF v_assessment.case_id IS DISTINCT FROM NEW.case_id
       OR v_assessment.assessment_type IS DISTINCT FROM 'READINESS'
       OR v_assessment.record_status IS DISTINCT FROM 'FINALIZED'
       OR v_assessment.outcome IS NULL
       OR v_assessment.outcome NOT IN (
           'READY', 'READY_BUT_BLOCKED'
       )
    THEN
        RAISE EXCEPTION
            'Handoff requires a finalized readiness assessment of the same Case';
    END IF;

    IF v_manifest.case_id IS DISTINCT FROM NEW.case_id
       OR v_manifest.manifest_purpose IS DISTINCT FROM 'HANDOFF'
       OR v_manifest.manifest_status IS DISTINCT FROM 'FROZEN'
    THEN
        RAISE EXCEPTION
            'Handoff requires a frozen HANDOFF manifest of the same Case';
    END IF;

    IF NEW.issued_at < v_assessment.assessed_at THEN
        RAISE EXCEPTION
            'Handoff cannot precede readiness assessment';
    END IF;

    IF NEW.baseline_status IS DISTINCT FROM 'ISSUED' THEN
        RAISE EXCEPTION
            'New handoff must start in ISSUED status';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER rt_handoff_guard
BEFORE INSERT OR UPDATE OR DELETE
ON public.handoff_baselines
FOR EACH ROW
EXECUTE FUNCTION public.rt_guard_handoff();


-- ============================================================
-- 9. DEV REVIEW RECORD
-- ============================================================

CREATE OR REPLACE FUNCTION public.rt_guard_dev_review()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
    v_case_id uuid;
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION
            'Dev review history cannot be deleted';
    END IF;

    IF TG_OP = 'UPDATE' THEN
        IF OLD.review_outcome <> 'PENDING' THEN
            RAISE EXCEPTION
                'Completed Dev review is immutable';
        END IF;

        IF ROW(
            NEW.handoff_id,
            NEW.reviewer_stakeholder_id,
            NEW.recorded_at,
            NEW.recorded_by
        ) IS DISTINCT FROM ROW(
            OLD.handoff_id,
            OLD.reviewer_stakeholder_id,
            OLD.recorded_at,
            OLD.recorded_by
        ) THEN
            RAISE EXCEPTION
                'Dev review identity cannot be changed';
        END IF;
    END IF;

    SELECT h.case_id
    INTO v_case_id
    FROM public.handoff_baselines h
    WHERE h.handoff_id = NEW.handoff_id
    FOR SHARE;

    IF NOT FOUND THEN
        RAISE EXCEPTION
            'Handoff does not exist';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM public.case_stakeholders cs
        WHERE cs.case_id = v_case_id
          AND cs.stakeholder_id = NEW.reviewer_stakeholder_id
    ) THEN
        RAISE EXCEPTION
            'Dev reviewer must belong to the handoff Case';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER rt_dev_review_guard
BEFORE INSERT OR UPDATE OR DELETE
ON public.dev_review_records
FOR EACH ROW
EXECUTE FUNCTION public.rt_guard_dev_review();


COMMIT;
