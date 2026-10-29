-- =========================================================
-- REQUIREMENT TOOL V2 — Node.js Backend Migration 001
-- Identity Store: public.app_users
--
-- Purpose: independent identity table so Node.js no longer
-- depends on Supabase Auth / auth.users for authentication.
--
-- Scope: additive only. Does NOT touch any of the 50 approved
-- business tables, their FKs, RLS policies, triggers, or the
-- existing rt_create_case_with_request / rt_update_case RPCs.
-- auth.users is left exactly as-is (no writes, no schema change).
--
-- Apply manually on Machine A. Review before running.
-- =========================================================

BEGIN;

CREATE TABLE public.app_users (
    user_id        uuid PRIMARY KEY,
    -- No DEFAULT gen_random_uuid(): the first row must reuse the
    -- existing auth.users.id for the current BA account so all 20
    -- existing FKs (REFERENCES auth.users(id)) keep resolving without
    -- any ALTER TABLE. See 002_seed_initial_ba_user.sql.

    email          varchar(320) NOT NULL UNIQUE,
    password_hash  text NOT NULL,
    -- Argon2id hash produced by backend/scripts/hash-password.ts.
    -- Never store plaintext or a hash computed anywhere else.

    rt_role        varchar(32) NOT NULL,
    display_name   varchar(240),
    is_active      boolean NOT NULL DEFAULT true,
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT chk_app_users_email_not_empty
        CHECK (length(btrim(email)) > 0),

    CONSTRAINT chk_app_users_password_hash_not_empty
        CHECK (length(btrim(password_hash)) > 0),

    -- Whitelist, matches the single MVP role. Extend this list (not
    -- the column type) when a second role is approved.
    CONSTRAINT chk_app_users_role
        CHECK (rt_role IN ('BA'))
);

COMMENT ON TABLE public.app_users IS
    'Node.js-managed identity store, independent of Supabase Auth. '
    'user_id values for pre-existing accounts intentionally reuse '
    'their auth.users.id so existing FKs need no change.';

COMMIT;
