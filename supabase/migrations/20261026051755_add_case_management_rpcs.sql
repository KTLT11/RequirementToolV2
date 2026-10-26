-- =========================================================
-- Task 01-A — Final proposed RPCs for Machine A review
-- NOT executed by Machine B. No schema change — additive only.
-- =========================================================

-- ---------------------------------------------------------
-- 1. rt_create_case_with_request
-- Atomic: Case + Incoming Request + CaseRequestAssociation + Audit
-- ---------------------------------------------------------
CREATE OR REPLACE FUNCTION public.rt_create_case_with_request(
    p_case_code varchar(40),
    p_case_name varchar(240),
    p_request_code varchar(40),
    p_request_text text,
    p_source_type varchar(40),
    p_received_at timestamptz,
    p_source_reference text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_caller uuid;
    v_rt_role text;
    v_new_case public.cases%ROWTYPE;
    v_new_request public.incoming_requests%ROWTYPE;
    v_association public.case_request_associations%ROWTYPE;
BEGIN
    -- Security: re-verify identity/role inside the function body.
    -- SECURITY DEFINER bypasses RLS entirely, so this check is the
    -- only thing standing between any `authenticated` caller and a
    -- write, regardless of what the Edge Function already checked.
    v_caller := auth.uid();
    v_rt_role := (auth.jwt() #>> '{app_metadata,rt_role}');
    IF v_caller IS NULL OR v_rt_role IS DISTINCT FROM 'BA' THEN
        RAISE EXCEPTION 'FORBIDDEN: caller is not an authenticated BA'
            USING ERRCODE = '42501';
    END IF;

    -- Validation: NULL and empty-string, every required parameter.
    IF p_case_code IS NULL OR length(btrim(p_case_code)) = 0 THEN
        RAISE EXCEPTION 'VALIDATION: case_code must not be empty'
            USING ERRCODE = '22023';
    END IF;
    IF p_case_name IS NULL OR length(btrim(p_case_name)) = 0 THEN
        RAISE EXCEPTION 'VALIDATION: case_name must not be empty'
            USING ERRCODE = '22023';
    END IF;
    IF p_request_code IS NULL OR length(btrim(p_request_code)) = 0 THEN
        RAISE EXCEPTION 'VALIDATION: request_code must not be empty'
            USING ERRCODE = '22023';
    END IF;
    IF p_request_text IS NULL OR length(btrim(p_request_text)) = 0 THEN
        RAISE EXCEPTION 'VALIDATION: request_text must not be empty'
            USING ERRCODE = '22023';
    END IF;
    IF p_source_type IS NULL OR length(btrim(p_source_type)) = 0 THEN
        RAISE EXCEPTION 'VALIDATION: source_type must not be empty'
            USING ERRCODE = '22023';
    END IF;
    IF p_received_at IS NULL THEN
        RAISE EXCEPTION 'VALIDATION: received_at must not be null'
            USING ERRCODE = '22023';
    END IF;

    INSERT INTO public.cases (
        case_code, case_name, status, primary_owner_user_id
    ) VALUES (
        btrim(p_case_code), btrim(p_case_name), 'IN_PROGRESS', v_caller
    )
    RETURNING * INTO v_new_case;

    INSERT INTO public.incoming_requests (
        request_code, request_text, source_type,
        received_at, recorded_by, source_reference
    ) VALUES (
        btrim(p_request_code), p_request_text, btrim(p_source_type),
        p_received_at, v_caller,
        NULLIF(btrim(coalesce(p_source_reference, '')), '')
    )
    RETURNING * INTO v_new_request;

    INSERT INTO public.case_request_associations (
        case_id, request_id, relation_role, linked_by
    ) VALUES (
        v_new_case.case_id, v_new_request.request_id, 'SOURCE', v_caller
    )
    RETURNING * INTO v_association;

    INSERT INTO public.audit_events (
        case_id, event_type, actor_user_id, event_payload, occurred_at
    ) VALUES (
        v_new_case.case_id,
        'CASE_CREATED',
        v_caller,
        jsonb_build_object(
            'case_code', v_new_case.case_code,
            'case_name', v_new_case.case_name,
            'request_id', v_new_request.request_id,
            'request_code', v_new_request.request_code
        ),
        now()
    );

    RETURN jsonb_build_object(
        'case', to_jsonb(v_new_case),
        'incomingRequest', to_jsonb(v_new_request),
        'association', to_jsonb(v_association)
    );

EXCEPTION
    WHEN unique_violation THEN
        RAISE EXCEPTION
            'CONFLICT: case_code or request_code already exists'
            USING ERRCODE = '23505';
END;
$$;

REVOKE ALL ON FUNCTION public.rt_create_case_with_request(
    varchar, varchar, varchar, text, varchar, timestamptz, text
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rt_create_case_with_request(
    varchar, varchar, varchar, text, varchar, timestamptz, text
) TO authenticated;


-- ---------------------------------------------------------
-- 2. rt_update_case
-- Scope: case_name only, per agreed limitation (no lifecycle,
-- no ownership transfer).
-- ---------------------------------------------------------
CREATE OR REPLACE FUNCTION public.rt_update_case(
    p_case_id uuid,
    p_case_name varchar(240)
)
RETURNS public.cases
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_caller uuid;
    v_rt_role text;
    v_updated_case public.cases%ROWTYPE;
BEGIN
    v_caller := auth.uid();
    v_rt_role := (auth.jwt() #>> '{app_metadata,rt_role}');
    IF v_caller IS NULL OR v_rt_role IS DISTINCT FROM 'BA' THEN
        RAISE EXCEPTION 'FORBIDDEN: caller is not an authenticated BA'
            USING ERRCODE = '42501';
    END IF;

    IF p_case_id IS NULL THEN
        RAISE EXCEPTION 'VALIDATION: case_id must not be null'
            USING ERRCODE = '22023';
    END IF;
    IF p_case_name IS NULL OR length(btrim(p_case_name)) = 0 THEN
        RAISE EXCEPTION 'VALIDATION: case_name must not be empty'
            USING ERRCODE = '22023';
    END IF;

    UPDATE public.cases
    SET case_name = btrim(p_case_name),
        updated_at = now()
    WHERE case_id = p_case_id
    RETURNING * INTO v_updated_case;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'NOT_FOUND: case % does not exist', p_case_id
            USING ERRCODE = 'P0002';
    END IF;

    INSERT INTO public.audit_events (
        case_id, event_type, actor_user_id, event_payload, occurred_at
    ) VALUES (
        v_updated_case.case_id,
        'CASE_UPDATED',
        v_caller,
        jsonb_build_object('case_name', v_updated_case.case_name),
        now()
    );

    RETURN v_updated_case;
END;
$$;

REVOKE ALL ON FUNCTION public.rt_update_case(uuid, varchar) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rt_update_case(uuid, varchar) TO authenticated;
