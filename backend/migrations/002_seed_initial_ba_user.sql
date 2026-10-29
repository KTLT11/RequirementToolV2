-- =========================================================
-- REQUIREMENT TOOL V2 — Node.js Backend Migration 002
-- Seed the existing BA account into public.app_users
--
-- Run this ONCE, manually, AFTER 001_create_app_users.sql has
-- been applied and reviewed on Machine A.
--
-- Before running, replace the three placeholders below:
--   1. <AUTH_USERS_ID>     - the current BA account's auth.users.id
--   2. <BA_EMAIL>          - that account's real email
--   3. <ARGON2ID_HASH>     - output of `npm run hash-password`
--                            (run locally, never pasted into chat,
--                            never committed to source control)
--
-- Do NOT commit a filled-in copy of this file. Keep the password
-- hash and the real email out of git history and out of any log.
-- =========================================================

-- Step 1 (read-only, run first to get <AUTH_USERS_ID> and confirm
-- there is exactly one account, matching the prior audit):
--
--   SELECT id, email FROM auth.users;

BEGIN;

INSERT INTO public.app_users (user_id, email, password_hash, rt_role, display_name)
VALUES (
    '<AUTH_USERS_ID>',   -- must exactly match the auth.users.id row above
    '<BA_EMAIL>',
    '<ARGON2ID_HASH>',
    'BA',
    NULL                 -- display_name optional, set if desired
);

COMMIT;

-- Step 2 (verification, run after commit):
--
--   SELECT a.user_id, a.email, a.rt_role, u.id AS auth_users_id
--   FROM public.app_users a
--   JOIN auth.users u ON u.id = a.user_id;
--
-- Expect exactly 1 row, with a.user_id = u.id.
