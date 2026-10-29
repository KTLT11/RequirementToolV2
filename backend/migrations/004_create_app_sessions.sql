-- =========================================================
-- REQUIREMENT TOOL V2 — Node.js Backend Migration 004
-- Server-side session store: public.app_sessions
--
-- Purpose: HttpOnly cookie sessions for Node.js Auth (Phase 3).
-- The cookie carries only an opaque session_id; this table is the
-- source of truth for who that session belongs to and whether it
-- is still valid. Chosen over in-memory (lost on restart, doesn't
-- scale past one process) and over stateless JWT (can't be revoked
-- on logout before expiry).
--
-- Scope: additive only. Does not touch auth.users, the 50 approved
-- business tables, their FKs, RLS, triggers, or the existing RPCs.
--
-- Apply manually on Machine A, AFTER 001-003.
-- =========================================================

BEGIN;

CREATE TABLE public.app_sessions (
    session_id   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id      uuid NOT NULL
        REFERENCES public.app_users(user_id) ON DELETE CASCADE,
    created_at   timestamptz NOT NULL DEFAULT now(),
    expires_at   timestamptz NOT NULL,
    revoked_at   timestamptz
    -- NULL = still valid until expires_at. Set on logout so a
    -- session can be invalidated immediately instead of waiting out
    -- its expiry - this is what makes server-side session strictly
    -- more revocable than a stateless JWT for the same cookie model.
);

CREATE INDEX idx_app_sessions_user_id ON public.app_sessions(user_id);

-- Lets an expiry sweep find candidates without a full table scan.
-- No automatic sweep job is created in this migration (out of scope
-- for MVP) - expired/revoked rows are simply never accepted by
-- authenticate.ts and can be pruned manually later if the table
-- grows large enough to matter.
CREATE INDEX idx_app_sessions_expires_at ON public.app_sessions(expires_at);

COMMENT ON TABLE public.app_sessions IS
    'Server-side session store for Node.js Auth. One row per active '
    'login; revoked_at is set on logout for immediate invalidation.';

COMMIT;

-- ---------------------------------------------------------
-- Grant: app_backend needs to create sessions (login), read them
-- (authenticate every request), and revoke them (logout). No DELETE -
-- revocation is a column update (revoked_at), matching the
-- no-hard-delete posture of the rest of the schema. Run this as part
-- of the same migration, after app_backend already exists (003).
-- ---------------------------------------------------------

GRANT SELECT, INSERT, UPDATE ON public.app_sessions TO app_backend;

ALTER TABLE public.app_sessions ENABLE ROW LEVEL SECURITY;

CREATE POLICY rt_app_backend_select ON public.app_sessions
    FOR SELECT TO app_backend USING (true);
CREATE POLICY rt_app_backend_insert ON public.app_sessions
    FOR INSERT TO app_backend WITH CHECK (true);
CREATE POLICY rt_app_backend_update ON public.app_sessions
    FOR UPDATE TO app_backend USING (true) WITH CHECK (true);

-- ---------------------------------------------------------
-- Verification queries (run after commit, read-only):
--
--   SELECT table_name, privilege_type
--   FROM information_schema.role_table_grants
--   WHERE grantee = 'app_backend' AND table_name = 'app_sessions'
--   ORDER BY privilege_type;
--   -- Expect exactly INSERT, SELECT, UPDATE. No DELETE.
-- ---------------------------------------------------------
