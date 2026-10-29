-- =========================================================
-- REQUIREMENT TOOL V2 — Node.js Backend Migration 005
-- Grants for: Case Context (P3-FR-002) + Case Scope + the shared
-- EntityIdentity/EntityRevision infrastructure they depend on.
--
-- Tables already exist (applied earlier on the Migration branch):
--   entity_identities, entity_revisions   (shared identity/revision
--                                           infra for ALL registered
--                                           entities, not just Context/
--                                           Scope — this grant is a
--                                           one-time prerequisite for
--                                           every later P1 module too)
--   business_contexts, case_scopes        (P3-FR-002)
--
-- This migration ONLY adds grants + app_backend-scoped RLS policies.
-- It does not create any table, does not touch the 50 approved
-- business tables' structure, FKs, triggers, or the existing
-- rt_ba_read policy (authenticated, auth.jwt()-based).
--
-- Apply manually on Machine A, AFTER 001-004.
-- =========================================================

BEGIN;

-- ---------------------------------------------------------
-- 1. Grants — mirrors exactly what the Node.js Context/Scope module
-- needs, verified against the planned repository/service code:
--
--   entity_identities   INSERT only at the time this migration was
--                        written — every new registered entity
--                        (Context, Scope, and later Requirement,
--                        Evidence, etc.) creates exactly one row here
--                        first. No SELECT was needed yet then.
--                        SELECT was later added by migration 012 once
--                        the generic Traceability API (P2-C) needed to
--                        resolve entity_type by entity_id directly -
--                        see that migration's comment.
--                        Still no UPDATE/DELETE — entity_type is fixed
--                        at registration, retired_at is a later
--                        concern out of scope for this migration.
--
--   entity_revisions     SELECT, INSERT — every write to a Context
--                        fact or Scope creates a new revision row
--                        (never UPDATE/DELETE — immutable by design,
--                        matches entity_revisions having no UPDATE/
--                        DELETE grant anywhere in the existing schema
--                        either). SELECT needed to read back history
--                        for GET /context and GET /scope responses.
--
--   business_contexts    SELECT, INSERT, UPDATE — list/get context
--                        facts, create new ones, and update content/
--                        knowledge_status on an existing fact (the
--                        row itself is mutable working state;
--                        immutability lives in entity_revisions, not
--                        here — matches the current_revision_no
--                        column's documented role as "display working
--                        revision").
--
--   case_scopes          SELECT, INSERT, UPDATE — same reasoning as
--                        business_contexts.
--
-- No DELETE anywhere, consistent with every other grant so far.
-- ---------------------------------------------------------

GRANT INSERT ON public.entity_identities TO app_backend;
GRANT SELECT, INSERT ON public.entity_revisions TO app_backend;
GRANT SELECT, INSERT, UPDATE ON public.business_contexts TO app_backend;
GRANT SELECT, INSERT, UPDATE ON public.case_scopes TO app_backend;

-- ---------------------------------------------------------
-- 2. RLS — same per-operation pattern as migrations 003/004: RLS
-- stays enabled (already ON from migration 13), existing rt_ba_read
-- policy for `authenticated` untouched, and a new policy per
-- operation scoped to app_backend only, mirroring the grants above
-- exactly.
-- ---------------------------------------------------------

CREATE POLICY rt_app_backend_insert ON public.entity_identities
    FOR INSERT TO app_backend WITH CHECK (true);

CREATE POLICY rt_app_backend_select ON public.entity_revisions
    FOR SELECT TO app_backend USING (true);
CREATE POLICY rt_app_backend_insert ON public.entity_revisions
    FOR INSERT TO app_backend WITH CHECK (true);

CREATE POLICY rt_app_backend_select ON public.business_contexts
    FOR SELECT TO app_backend USING (true);
CREATE POLICY rt_app_backend_insert ON public.business_contexts
    FOR INSERT TO app_backend WITH CHECK (true);
CREATE POLICY rt_app_backend_update ON public.business_contexts
    FOR UPDATE TO app_backend USING (true) WITH CHECK (true);

CREATE POLICY rt_app_backend_select ON public.case_scopes
    FOR SELECT TO app_backend USING (true);
CREATE POLICY rt_app_backend_insert ON public.case_scopes
    FOR INSERT TO app_backend WITH CHECK (true);
CREATE POLICY rt_app_backend_update ON public.case_scopes
    FOR UPDATE TO app_backend USING (true) WITH CHECK (true);

COMMIT;

-- ---------------------------------------------------------
-- Verification query (run after commit, read-only):
--
--   SELECT table_name, privilege_type
--   FROM information_schema.role_table_grants
--   WHERE grantee = 'app_backend'
--     AND table_name IN ('entity_identities', 'entity_revisions',
--                         'business_contexts', 'case_scopes')
--   ORDER BY table_name, privilege_type;
--   -- Expect: entity_identities -> INSERT only;
--   --         entity_revisions -> INSERT, SELECT;
--   --         business_contexts / case_scopes -> INSERT, SELECT, UPDATE.
--   --         No DELETE anywhere.
-- ---------------------------------------------------------
