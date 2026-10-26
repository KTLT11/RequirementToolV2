
-- REQUIREMENT TOOL V2
-- BUSINESS INTEGRITY - CORE
-- Revision, Manifest, Case consistency
-- No table creation or data deletion

BEGIN;

-- ============================================
-- A. IMMUTABLE ENTITY / RELATION REVISIONS
-- ============================================

CREATE OR REPLACE FUNCTION public.rt_reject_revision_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
    RAISE EXCEPTION
        'Immutable revision: UPDATE/DELETE is not permitted on %',
        TG_TABLE_NAME;
END;
$$;

CREATE TRIGGER rt_entity_revision_immutable
BEFORE UPDATE OR DELETE
ON public.entity_revisions
FOR EACH ROW
EXECUTE FUNCTION public.rt_reject_revision_mutation();

CREATE TRIGGER rt_relation_revision_immutable
BEFORE UPDATE OR DELETE
ON public.relation_revisions
FOR EACH ROW
EXECUTE FUNCTION public.rt_reject_revision_mutation();


-- ============================================
-- B. RELATION REVISION ENDPOINT VALIDATION
-- ============================================

CREATE OR REPLACE FUNCTION public.rt_check_relation_revision()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
    v_source uuid;
    v_target uuid;
    v_revision_source uuid;
    v_revision_target uuid;
BEGIN
    SELECT r.source_entity_id, r.target_entity_id
      INTO v_source, v_target
    FROM public.traceability_relations r
    WHERE r.relation_id = NEW.relation_id
    FOR SHARE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Relation does not exist';
    END IF;

    IF NEW.source_entity_revision_id IS NOT NULL THEN
        SELECT er.entity_id INTO v_revision_source
        FROM public.entity_revisions er
        WHERE er.entity_revision_id = NEW.source_entity_revision_id;

        IF v_revision_source IS DISTINCT FROM v_source THEN
            RAISE EXCEPTION
                'Source revision does not belong to relation source';
        END IF;
    END IF;

    IF NEW.target_entity_revision_id IS NOT NULL THEN
        SELECT er.entity_id INTO v_revision_target
        FROM public.entity_revisions er
        WHERE er.entity_revision_id = NEW.target_entity_revision_id;

        IF v_revision_target IS DISTINCT FROM v_target THEN
            RAISE EXCEPTION
                'Target revision does not belong to relation target';
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER rt_relation_revision_endpoint
BEFORE INSERT
ON public.relation_revisions
FOR EACH ROW
EXECUTE FUNCTION public.rt_check_relation_revision();


-- ============================================
-- C. FROZEN MANIFEST IMMUTABILITY
-- ============================================

CREATE OR REPLACE FUNCTION public.rt_guard_manifest_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
    IF OLD.manifest_status = 'FROZEN' THEN
        RAISE EXCEPTION
            'Frozen manifest cannot be updated or deleted';
    END IF;

    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;

    -- Allowed state change: DRAFT -> FROZEN.
    -- Other changes remain subject to existing CHECKs.
    RETURN NEW;
END;
$$;

CREATE TRIGGER rt_manifest_guard
BEFORE UPDATE OR DELETE
ON public.baseline_manifests
FOR EACH ROW
EXECUTE FUNCTION public.rt_guard_manifest_update();


CREATE OR REPLACE FUNCTION public.rt_guard_manifest_item()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
    v_manifest_id uuid;
    v_status text;
BEGIN
    IF TG_OP = 'INSERT' THEN
        v_manifest_id := NEW.manifest_id;
    ELSE
        v_manifest_id := OLD.manifest_id;
    END IF;

    -- Serialize membership operations against freezing.
    SELECT bm.manifest_status
      INTO v_status
    FROM public.baseline_manifests bm
    WHERE bm.manifest_id = v_manifest_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Manifest does not exist';
    END IF;

    IF v_status = 'FROZEN' THEN
        RAISE EXCEPTION
            'Cannot modify items of a frozen manifest';
    END IF;

    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;

    IF TG_OP = 'UPDATE'
       AND NEW.manifest_id IS DISTINCT FROM OLD.manifest_id
    THEN
        RAISE EXCEPTION
            'Moving a manifest item between manifests is prohibited';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER rt_manifest_item_guard
BEFORE INSERT OR UPDATE OR DELETE
ON public.manifest_items
FOR EACH ROW
EXECUTE FUNCTION public.rt_guard_manifest_item();


-- ============================================
-- D. FORM RESPONSE CASE CONSISTENCY
-- ============================================

CREATE OR REPLACE FUNCTION public.rt_check_form_response_case()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
    v_case_id uuid;
BEGIN
    SELECT sf.case_id INTO v_case_id
    FROM public.form_versions fv
    JOIN public.stakeholder_forms sf
      ON sf.form_id = fv.form_id
    WHERE fv.form_version_id = NEW.form_version_id;

    IF v_case_id IS DISTINCT FROM NEW.case_id THEN
        RAISE EXCEPTION
            'Form response case differs from form owner case';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER rt_form_response_case
BEFORE INSERT OR UPDATE
ON public.form_responses
FOR EACH ROW
EXECUTE FUNCTION public.rt_check_form_response_case();


-- ============================================
-- E. VALIDATION / ASSESSMENT CASE CONSISTENCY
-- ============================================

CREATE OR REPLACE FUNCTION public.rt_check_manifest_case()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
    v_manifest_case uuid;
BEGIN
    SELECT bm.case_id INTO v_manifest_case
    FROM public.baseline_manifests bm
    WHERE bm.manifest_id = NEW.manifest_id;

    IF v_manifest_case IS DISTINCT FROM NEW.case_id THEN
        RAISE EXCEPTION
            'Manifest belongs to a different Case';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER rt_validation_manifest_case
BEFORE INSERT OR UPDATE
ON public.validation_runs
FOR EACH ROW
EXECUTE FUNCTION public.rt_check_manifest_case();

CREATE TRIGGER rt_assessment_manifest_case
BEFORE INSERT OR UPDATE
ON public.assessment_records
FOR EACH ROW
EXECUTE FUNCTION public.rt_check_manifest_case();


-- ============================================
-- F. DOCUMENT SNAPSHOT CASE CONSISTENCY
-- ============================================

CREATE OR REPLACE FUNCTION public.rt_check_snapshot_case()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
    v_document_case uuid;
    v_manifest_case uuid;
BEGIN
    SELECT d.case_id INTO v_document_case
    FROM public.documents d
    WHERE d.document_id = NEW.document_id;

    SELECT bm.case_id INTO v_manifest_case
    FROM public.baseline_manifests bm
    WHERE bm.manifest_id = NEW.manifest_id;

    IF v_document_case IS DISTINCT FROM v_manifest_case THEN
        RAISE EXCEPTION
            'Document snapshot and manifest belong to different Cases';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER rt_snapshot_case
BEFORE INSERT OR UPDATE
ON public.document_snapshots
FOR EACH ROW
EXECUTE FUNCTION public.rt_check_snapshot_case();


-- ============================================
-- G. PROTECT PARENT OWNERSHIP / ENDPOINTS
-- ============================================

CREATE OR REPLACE FUNCTION public.rt_guard_owner_key()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
    IF TG_ARGV[0] = 'case_id'
       AND NEW.case_id IS DISTINCT FROM OLD.case_id
    THEN
        RAISE EXCEPTION
            'Case ownership cannot be changed on %',
            TG_TABLE_NAME;
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER rt_manifest_case_stable
BEFORE UPDATE OF case_id
ON public.baseline_manifests
FOR EACH ROW
EXECUTE FUNCTION public.rt_guard_owner_key('case_id');

CREATE TRIGGER rt_document_case_stable
BEFORE UPDATE OF case_id
ON public.documents
FOR EACH ROW
EXECUTE FUNCTION public.rt_guard_owner_key('case_id');

CREATE TRIGGER rt_form_case_stable
BEFORE UPDATE OF case_id
ON public.stakeholder_forms
FOR EACH ROW
EXECUTE FUNCTION public.rt_guard_owner_key('case_id');

CREATE TRIGGER rt_validation_case_stable
BEFORE UPDATE OF case_id
ON public.validation_runs
FOR EACH ROW
EXECUTE FUNCTION public.rt_guard_owner_key('case_id');

CREATE TRIGGER rt_assessment_case_stable
BEFORE UPDATE OF case_id
ON public.assessment_records
FOR EACH ROW
EXECUTE FUNCTION public.rt_guard_owner_key('case_id');


CREATE OR REPLACE FUNCTION public.rt_guard_relation_endpoints()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
    IF NEW.source_entity_id IS DISTINCT FROM OLD.source_entity_id
       OR NEW.target_entity_id IS DISTINCT FROM OLD.target_entity_id
    THEN
        RAISE EXCEPTION
            'Traceability relation endpoints are immutable';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER rt_relation_endpoints_stable
BEFORE UPDATE OF source_entity_id, target_entity_id
ON public.traceability_relations
FOR EACH ROW
EXECUTE FUNCTION public.rt_guard_relation_endpoints();

-- Prevent reassignment of existing form versions to another form.
CREATE OR REPLACE FUNCTION public.rt_guard_form_version_owner()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
    IF NEW.form_id IS DISTINCT FROM OLD.form_id THEN
        RAISE EXCEPTION
            'Form version cannot be reassigned to another form';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER rt_form_version_owner_stable
BEFORE UPDATE OF form_id
ON public.form_versions
FOR EACH ROW
EXECUTE FUNCTION public.rt_guard_form_version_owner();

COMMIT;
