# Backend — Phases 1-6: Identity, Database Access, Auth, Case API, Discovery, Requirement Spec, Stakeholder/Evidence, Traceability, Structural Validation

Phases 1-4 are complete and verified. Phase 6 (the full MVP API gap
analysis against the SRS/Framework/Data Dictionary) is complete through
P1 and P2: Context/Scope (P1a), Discovery (P1b/P1c), Requirement
Specification (P1d), Stakeholder & Evidence (P2-A/B), Traceability
extension (P2-C), and minimal Structural Validation (P2-D). Current
state: **196/196** integration tests passing against live Supabase
Cloud, 77 unit tests, 13 migrations (001-013) applied.

## Phase 1 — Identity Foundation (done, kept for reference)

1. Apply `migrations/001_create_app_users.sql` on Machine A.
2. `npm install && npm run hash-password` — enter the new BA password,
   copy the printed Argon2id hash.
3. Run the read-only query in `migrations/002_seed_initial_ba_user.sql`
   to get the existing BA account's `auth.users.id`.
4. Fill in a **local, uncommitted copy** of
   `002_seed_initial_ba_user.sql` with that UUID, the real email, and
   the hash from step 2, then apply it.
5. Run the verification query at the bottom of that file.

## Phase 2 — Database Access (this phase)

1. Review `migrations/003_create_app_backend_role.sql`. Before
   applying, generate a long random password on Machine A and put it
   in the `CREATE ROLE ... PASSWORD '...'` line — do not reuse any
   existing Supabase credential, do not commit the filled-in file.
2. Apply the migration. It:
   - creates the `app_backend` role (`NOSUPERUSER NOCREATEDB
     NOCREATEROLE NOBYPASSRLS`);
   - grants `USAGE ON SCHEMA public` (required for any table grant to
     resolve at all on Supabase Cloud — schema-level, not a widening
     of table access);
   - grants exactly `SELECT`/`INSERT`/`UPDATE` on the 6 tables the
     current Case API touches (never `DELETE`, never on any other
     table — verified against `cases/index.ts` directly, and against
     every `CREATE TRIGGER` in the schema to confirm Create/Update
     Case fires none of them);
   - adds one RLS policy per operation (`rt_app_backend_select` /
     `_insert` / `_update`), each mirroring the GRANTs exactly, rather
     than a single blanket policy — so a future grant on a 7th
     operation can't silently work just because an old catch-all
     policy already covered it.
   RLS stays enabled throughout; nothing existing (`rt_ba_read`,
   `authenticated` grants) is touched.
3. Run the four read-only verification queries at the bottom of
   `003_create_app_backend_role.sql` directly in Supabase Studio —
   they confirm grants, schema usage, role attributes, and that
   `app_backend` has no role membership that could widen its effective
   privileges.
4. Copy `.env.example` to `.env.local` (already gitignored) and fill
   in `PGHOST`/`PGPORT`/`PGDATABASE` from Supabase → Project Settings
   → Database, plus the `app_backend` password from step 1.
5. `npm install` (adds `dotenv`), then `npm run check-db-access`. This
   connects as `app_backend` over `pg` and runs two separate sections:
   **Section A** (expected to succeed: grants, schema usage, role
   attributes, membership) and **Section B** (expected to be denied:
   reading `stakeholders`, deleting from `cases`) — kept apart so a
   denial-path failure in B is never confused with a missing-grant
   failure in A. Expect `ALL CHECKS PASSED`.

## Phase 3 — Node.js Auth

1. Review `migrations/004_create_app_sessions.sql`. Additive: one new
   table (`app_sessions`, FK to `app_users`, `ON DELETE CASCADE` so a
   deleted test user's sessions are cleaned up automatically), plus
   `GRANT SELECT, INSERT, UPDATE` (no `DELETE` — logout sets
   `revoked_at` rather than removing the row) and the same
   per-operation RLS policy pattern as migration 003. Apply on Machine
   A after 001-003.
2. Run the verification query at the bottom of that file — expect
   exactly `INSERT, SELECT, UPDATE` granted to `app_backend` on
   `app_sessions`, no `DELETE`.
3. `npm run typecheck` and `npm test` — the automated suite (13 tests)
   covers error-code mapping, `authorize.ts`'s role check, and every
   validation rule in the Case service (missing fields, bad UUID,
   unparseable dates, empty case_name) without needing a database
   connection at all (the pool is constructed lazily, only when a
   query actually runs).
4. `npm run dev` starts the server on `PORT` (default 3000) with
   `POST /api/auth/login`, `GET /api/auth/me`, `POST /api/auth/logout`.
   Sessions are an HttpOnly, `SameSite=Lax` cookie; `Secure` turns on
   automatically when `NODE_ENV=production`. No signup, no password
   reset, no OAuth — login only, against the row(s) already in
   `app_users`.

## Phase 4 — Case Management API

`GET/POST /api/cases`, `GET/PATCH /api/cases/:caseId` — ports the
same 4 behaviors the old Edge Function (`supabase/functions/cases/
index.ts`) and its two RPCs implemented, with identical validation
rules and the identical error contract (`VALIDATION_ERROR` 400,
`UNAUTHENTICATED` 401, `FORBIDDEN` 403, `NOT_FOUND` 404, `CONFLICT`
409). The difference is only *how* atomicity and authorization are
achieved:

- Create Case runs 4 inserts (`cases`, `incoming_requests`,
  `case_request_associations`, `audit_events`) inside one
  `withTransaction()` — a real `BEGIN`/`COMMIT`/`ROLLBACK`, not a
  PL/pgSQL function. A `unique_violation` (duplicate `case_code` or
  `request_code`) rolls back everything and surfaces as `CONFLICT`,
  same as before.
- The actor id for `primary_owner_user_id`, `recorded_by`,
  `linked_by`, and `audit_events.actor_user_id` always comes from
  `req.user.userId` (set by `authenticate.ts` from the session), never
  from the request body — a client cannot claim to be a different
  user by sending a different id in the payload.
- `rt_create_case_with_request` / `rt_update_case` are left completely
  untouched — not called, not modified, not revoked. They remain
  reachable via the old Edge Function path until a later phase
  retires that path once this one is proven out.

See `test/MANUAL_INTEGRATION.md` for a full manual run-through
(login, all 4 Case endpoints, error paths, rollback verification)
using a disposable test account — never the real BA credentials.

## Phase 6 (P1a) — Case Context + Scope

Scope: from the full MVP API gap analysis against the SRS
(`Phase_3_Application.md`), Requirement Framework, and the 50-table
Data Dictionary (kept outside this repo, in the project's Downloads
folder) — this slice covers P3-FR-002 only. The remaining P1/P2/P3
groups (Discovery, Stakeholder & Evidence, Requirement & AC, Quality
Validation, Confirmation & Output) are tracked separately and not yet
implemented.

1. Apply `migrations/005_grant_context_scope_entity_infra.sql` on
   Machine A, after 001-004. It only adds grants and app_backend-scoped
   RLS policies on 4 tables that already exist from the `Migration`
   branch (`entity_identities`, `entity_revisions`, `business_contexts`,
   `case_scopes`) — no table creation, no change to the 50 approved
   business tables, their FKs, triggers, or the existing `rt_ba_read`
   policy.
2. Run the verification query at the bottom of that file — expect
   `entity_identities` → INSERT only; `entity_revisions` → INSERT,
   SELECT; `business_contexts` / `case_scopes` → INSERT, SELECT,
   UPDATE. No `DELETE` anywhere.
3. New endpoints:
   - `GET/POST /api/cases/:caseId/context`, `PATCH /api/context/:contextId`
     — one BusinessContext row per fact (business problem, need,
     current/desired state, stakeholder, scope, constraint,
     dependency), each with its own `knowledge_status`
     (KNOWN/UNKNOWN/ASSUMPTION — matches the DB's own CHECK
     constraint exactly, no stricter rule invented). Every create/
     update also writes an immutable `entity_revisions` row via the
     new shared `src/modules/entities/repository.ts` helper
     (`registerEntity` + `createRevision`) — this is the pattern every
     later P1 module (Requirement, Evidence, etc.) will reuse, since
     they all share the same EntityIdentity/EntityRevision
     infrastructure.
   - `GET/PUT /api/cases/:caseId/scope` — one versioned CaseScope per
     Case; PUT creates it on first call and creates a new revision
     (bumping `current_revision_no`) on every call after that, so the
     caller never needs to know whether a scope already exists.
4. `npm run typecheck` and `npm test` — the automated suite (21 tests
   now) adds 8 validation-only tests for Context/Scope, still with no
   database connection required.
5. `npm run test:integration` now also exercises Context (create,
   list, update with a revision bump, 404 on an unknown context id)
   and Scope (first PUT creates, second PUT revises, GET returns the
   latest revision) as part of the same Case created during that run.

**Explicitly deferred, not silently dropped** (see the Phase 6 plan
for the full gap analysis and reasoning):
- **FR-003 (Complexity Assessment)**: confirmed via business decision
  to be a standalone, historized record — but the Data Dictionary has
  no table for it (grepped all 50 tables for "complexity", zero
  matches). This is a genuine schema gap requiring a new table via a
  separately-approved migration; not implemented here.
- **FR-004 (customer-supplied source documents)**: out of scope for
  this MVP slice.
- Document rendering, Stakeholder/Evidence, Requirement & AC, Quality
  Validation, Confirmation & Output: separate, larger slices — see
  the plan file for the full breakdown and priority order.

## Phase 6 (P1b/P1c) — Discovery: Module Application, Discovery Answer, Information Gap

1. Apply `migrations/006_grant_discovery_module_infra.sql` on Machine
   A, after 001-005. It:
   - grants `app_backend` `SELECT/INSERT/UPDATE` on
     `module_applications`, `discovery_answers`, `information_gaps`
     (no `DELETE` anywhere — a module is marked `REMOVED`, an answer
     is revised, a gap is marked `RESOLVED`; none of these are ever
     row-deleted), and `SELECT` only on `definition_versions` (the
     Rule Registry — read-only, no admin API, per FR-023 AC-04 /
     FR-023B AC-04);
   - adds the same per-operation RLS policy pattern as migrations
     003-005;
   - seeds exactly 7 rows into `definition_versions`
     (`definition_type = 'MODULE'`), one per Discovery Module
     (PROC/INT/RULE/DATA/PERM/EXC/NFR), sourced directly from
     `Requirement_Framework.md` section 2.6 — module id, name, and
     applicability condition copied from that document, nothing
     invented;
   - seeds exactly 101 rows (`definition_type = 'QUESTION'`), one per
     question actually listed in each module's "C. Ordered
     Elicitation Guide" table (PROC=19, INT=16, RULE=14, DATA=17,
     PERM=14, EXC=12, NFR=9 — counted directly from the document, not
     assumed), with the exact question id (e.g. `PROC-Q-01`,
     `PROC-Q-12A`), question text, and Required Information copied
     verbatim — no paraphrasing, no invented questions.
2. **Schema note, corrected after a live integration-test failure**:
   the table-creation migration alone defines all 3 Discovery tables'
   primary keys as plain `uuid PRIMARY KEY DEFAULT gen_random_uuid()`
   with no FK — but a *later* repair migration
   (`20261022074857_repair_entity_identity_foreign_keys.sql`) adds a
   FK to `entity_identities` on 13 tables, **including**
   `discovery_answers.answer_id` and `information_gaps.gap_id`, but
   **not** `module_applications.*_id`. This was missed on first
   reading (only the creation migration was checked) and surfaced as
   a live `23503 foreign key violation` the first time
   `test:integration` actually ran against Cloud. Corrected: Discovery
   Answer and Information Gap *do* call
   `registerEntity()`/`createRevision()` on every create/update,
   exactly like Context/Scope — Module Application is the only one of
   the three that doesn't, since it's confirmed absent from the
   repair migration's table list.
3. Run the two verification queries at the bottom of
   `006_grant_discovery_module_infra.sql` — expect the grants above,
   and exactly 7 `MODULE` rows (one per module code).
4. New endpoints:
   - `GET/POST /api/cases/:caseId/modules`,
     `PATCH /api/module-applications/:moduleApplicationId` — apply a
     Discovery Module to a Case (validated against a real, `ACTIVE`
     `MODULE` definition — not just "is this a UUID"), then transition
     `application_status` (`ACTIVE → COMPLETED/REMOVED`).
   - `GET/POST /api/cases/:caseId/discovery-answers`,
     `PATCH /api/discovery-answers/:answerId` — record an answer to a
     specific seeded question (`question_definition_version_id` must
     resolve to a real, `ACTIVE` `QUESTION` definition — this was
     explicitly required, not left as a bare UUID check), with its own
     `answer_status` (KNOWN/UNKNOWN/ASSUMPTION/N_A, matching the DB's
     own CHECK exactly). Deliberately distinct from Evidence (a
     separate, not-yet-implemented module that tracks externally
     sourced assertions with their own Review Status / Evidence
     Status pair) — a Discovery Answer is the BA's own internal
     record, not a stakeholder-provided assertion.
   - `GET/POST /api/cases/:caseId/gaps`, `PATCH /api/gaps/:gapId` —
     BA-recorded gap tracking only. Automatic gap detection via
     rule/heuristic/AI (FR-009 AC-04) is explicitly out of scope here,
     per the Application Functional Guide's "chưa cần... rule
     engine... AI thực tế" — no detection logic runs anywhere in this
     slice, a BA creates a gap by calling the API directly. Status
     transitions follow the SRS's own state machine (OPEN ⇄
     CLARIFYING → RESOLVED ⇄ OPEN), enforced in `service.ts`, not left
     unchecked.
   - `GET /api/definitions?type=MODULE|QUESTION|...` — read-only Rule
     Registry lookup, so a caller can discover which
     `definition_version_id` values exist before referencing one from
     the two POST endpoints above. No corresponding
     create/update/delete endpoint exists, and none is planned for
     this MVP.
5. `npm run typecheck` and `npm test` — 30 tests now (9 new
   validation-only tests for these 3 modules), still no database
   connection required.
6. Integration test coverage for these endpoints is prepared
   separately (see `test/integration.ts`) and requires migration 006
   applied first, since it needs real seeded `MODULE`/`QUESTION`
   definition ids to reference.

**Explicitly out of scope for this slice, not silently dropped**:
Rule Engine / automatic validation execution (FR-020 series), Pattern
persistence (FR-007 has no table — Pattern is a discovery hypothesis,
not a stored entity, per the Data Dictionary), and Information
Complete checkpoint evaluation (FR-011, which belongs to the not-yet-
implemented Quality Validation module and shares `ValidationRun`/
`ValidationResult` with it).

## Phase 6 (P1d) — Requirement, Acceptance Criteria, Business Rule, Workflow, Business Data Definition

1. Apply `migrations/007_grant_requirement_spec_infra.sql` on Machine
   A, after 001-006. It:
   - grants `SELECT/INSERT/UPDATE` (no `DELETE`) on all 8 "group E"
     tables (`requirements`, `acceptance_criteria`, `business_rules`,
     `workflow_scenarios`, `workflow_steps`, `workflow_transitions`,
     `business_data_definitions`, `business_data_attributes`), plus
     `SELECT/INSERT` on `traceability_relations` /
     `relation_revisions` (existing tables, needed for FR-018 below);
   - adds the same per-operation RLS policy pattern as prior
     migrations;
   - seeds one `RELATION_TYPE` definition, `DECOMPOSED_FROM`, used by
     Requirement Split (FR-018) to link a child Requirement back to
     its parent.
2. **Full migration history read before writing this migration**
   (the lesson from migration 006's mistake): all 8 group-E tables
   are created with plain `uuid PRIMARY KEY DEFAULT gen_random_uuid()`
   in the table-creation migration, but the SAME later repair
   migration that fixed Discovery Answer / Information Gap
   (`20261022074857_repair_entity_identity_foreign_keys.sql`) also
   adds a FK to `entity_identities` on **all 8 of them**. Confirmed by
   reading every repair migration in full, not just the one that
   matched by name. All 8 modules below therefore use
   `registerEntity()`/`createRevision()` on every create/update, the
   same pattern as Context/Scope/Discovery Answer/Information Gap.
3. Run the verification query at the bottom of
   `007_grant_requirement_spec_infra.sql` — expect all 8 tables with
   `INSERT, SELECT, UPDATE`, no `DELETE`.
4. New endpoints:
   - `GET/POST /api/cases/:caseId/requirements`,
     `GET/PATCH /api/requirements/:requirementId` — Requirement
     Formation (FR-017). `requirement_type` is `FUNCTIONAL` or
     `NON_FUNCTIONAL`; `lifecycle_status` is `DRAFT` (default),
     `QUALITY_READY`, or `STAKEHOLDER_CONFIRMED` (names taken from the
     Framework's own Layer 2 checkpoints — the DB itself has no CHECK
     constraint on this column, so this whitelist is this service's
     own choice).
   - `POST /api/requirements/:requirementId/split` — Requirement
     Decomposition (FR-018). `requirements` has no
     `parent_requirement_id` column anywhere in the schema, so per
     the approved design this creates the child Requirement and links
     it to the parent via a `DECOMPOSED_FROM` `traceability_relations`
     row (`source_entity_id` = child, `target_entity_id` = parent),
     reusing the existing Traceability infrastructure (FR-016) rather
     than adding a schema column. Both Requirements are structurally
     guaranteed to share the same Case (the child always inherits
     `parent.case_id`, never a client-supplied one); a
     `wouldCreateDecompositionCycle()` check walks the existing
     `DECOMPOSED_FROM` chain before linking (defense-in-depth — not
     reachable via this endpoint alone, since the child is always
     freshly created and cannot already be an ancestor of anything,
     but kept explicit for when a future re-parent operation is
     added). `assertNoExistingParentLink()` (the "at most one active
     parent per child" rule) is implemented and exported but not yet
     wired to any route, since no re-parent endpoint exists in this
     slice — it exists so that invariant is enforced the moment one
     is added, not designed in after the fact.
   - `GET/POST /api/requirements/:requirementId/acceptance-criteria`,
     `PATCH /api/acceptance-criteria/:acId` — Acceptance Criteria
     (FR-019), owned by exactly one Requirement.
   - `GET/POST /api/cases/:caseId/business-rules`,
     `PATCH /api/business-rules/:ruleId` — a Case-owned, independently
     versioned Business Rule, referenceable by many Requirements.
     Deliberately distinct from two things it could be confused with:
     the inline rule prose inside a Requirement's own `statement`
     text (not independently versioned or cross-referenceable), and
     `CHECK_RULE` definitions in the Rule Registry
     (`definition_versions.definition_type = 'CHECK_RULE'`, which
     belong to the not-yet-implemented Validation Engine and describe
     *how to evaluate* a requirement, not a *business* rule from the
     customer's domain) — this module never reads or writes
     `definition_versions`.
   - `GET/POST /api/cases/:caseId/workflows`,
     `GET /api/workflows/:workflowId` (includes its steps and
     transitions), `POST /api/workflows/:workflowId/steps`,
     `POST /api/workflows/:workflowId/transitions` — backs the
     Process Discovery Module's output. `workflow_transitions` has a
     Postgres-enforced composite FK on both
     `(workflow_id, source_step_id)` and
     `(workflow_id, target_step_id)` into
     `workflow_steps(workflow_id, step_id)`, so a transition whose
     endpoints don't both belong to the given workflow is rejected by
     the database itself (surfaced here as `VALIDATION_ERROR`, not a
     raw `23503`).
   - `GET/POST /api/cases/:caseId/data-definitions`,
     `GET /api/data-definitions/:dataDefinitionId` (includes its
     attributes), `POST /api/data-definitions/:dataDefinitionId/attributes`
     — backs the Data / Entity Discovery Module's output. Deliberately
     scoped to business-level entities/attributes only, per the
     Framework's own rule for this module ("không mở rộng thành thiết
     kế database hoặc data model kỹ thuật") — this is not a technical
     schema designer.
5. `npm run typecheck` and `npm test` — 44 tests now (14 new
   validation-only tests for these 5 modules), still no database
   connection required. Tests for `createAcService`/`createRuleService`/
   `createStepService`/`createTransitionService`/`createAttributeService`
   use a non-UUID parent id specifically, since each of those create
   paths looks up its parent record via a real DB query before
   validating the rest of the body — a valid-UUID-but-fake parent id
   would reach that query and require a live connection.
6. Integration test coverage (`test/integration.ts`) now also
   exercises: Create/Get/Update Requirement (including the duplicate
   `requirement_code` → `CONFLICT` path), Create/Update Acceptance
   Criteria, Requirement Split (verifying the response links back to
   the parent, and a 404 when splitting a nonexistent parent),
   Create/Update Business Rule, a full Workflow with 2 steps + 1
   transition (plus a negative test for a transition referencing a
   step id that doesn't exist), and a Business Data Definition with 1
   Attribute.
7. **Migration 008 required before Requirement Split works** — the
   first live run against Cloud surfaced
   `permission denied for table traceability_relations` on every
   split attempt. Root cause: inserting into `relation_revisions`
   fires an existing trigger
   (`rt_check_relation_revision`/`rt_relation_revision_endpoint`, from
   `20261022080939_enforce_business_integrity_core.sql`) that runs a
   row-locking `SELECT ... FOR SHARE` against
   `traceability_relations` — and Postgres RLS checks a row-locking
   SELECT against the table's **UPDATE** policy, not its SELECT
   policy. Migration 007 only granted SELECT/INSERT there. Apply
   `migrations/008_fix_traceability_relation_lock_permission.sql`
   (after 007) to add the missing `GRANT UPDATE` + matching RLS
   policy — this does not newly let the backend's own code rewrite
   relations (no `updateRelation` function exists anywhere in
   `src/modules/traceability/repository.ts`); it only satisfies the
   trigger's internal row lock. This could not have been caught by
   `npm test` (unit tests never touch a real Postgres trigger) — only
   surfaced via `npm run test:integration` against live Cloud data.

## Phase 6 (P2) — Stakeholder & Evidence, Traceability extension, Structural Validation

Scope: continues the MVP roadmap after P1 (110/110 integration tests
passing at that point) — Stakeholder/Role/Authority/Form (group B),
Evidence/Review/Confirmation/Business Decision (group D, partial —
`issues`/`issue_resolutions` deliberately left for a later batch, not
in P2's approved scope), Traceability extension, and minimal
Structural Validation. Final state after this phase: **196/196**
integration tests passing against live Supabase Cloud.

### P2-A — Stakeholder, Case Role/Authority, Form/Response

1. Apply `migrations/009_grant_stakeholder_form_infra.sql` on Machine
   A, after 001-008.
2. **Schema note (caught before writing any code, not via a live
   failure this time)**: the Stakeholder/Form table group was created
   twice. The two original creation migrations
   (`20261022065449_create_stakeholder_authority_schema.sql`,
   `20261022065935_create_form_management_schema.sql`) were entirely
   superseded by a later repair migration
   (`20261022071002_repair_stakeholder_form_schema.sql`), which DROPs
   all 10 tables and recreates them with a different,
   Data-Dictionary-aligned shape. Migration 009's grants/policies and
   every repository in this batch are written against the repair
   migration's shape, confirmed by a direct read of that file — not
   the two superseded originals. None of these 10 tables carry a FK to
   `entity_identities` (grepped the repair migration — zero matches),
   so no `registerEntity()`/`createRevision()` calls appear anywhere
   in this batch.
3. New endpoints:
   - `GET/POST /api/stakeholders`, `GET /api/stakeholders/:id` — a
     reusable Stakeholder profile, not scoped to any one Case.
   - `GET/POST /api/cases/:caseId/stakeholders` — adds a Stakeholder to
     a Case together with its first Role Assignment, in one
     transaction (a CaseStakeholder with zero roles has no good UI
     representation, so the two inserts aren't split across separate
     endpoints). `POST /api/case-stakeholders/:id/roles` adds a further
     role over time; `POST /api/case-stakeholders/:id/authority` grants
     an Authority Assignment (optionally tied to a specific Role
     Assignment — validated to belong to the same CaseStakeholder).
   - `GET/POST /api/cases/:caseId/forms`,
     `POST /api/forms/:formId/versions` (creates a DRAFT version plus
     all its question items in one transaction — question structure is
     frozen with the version, there is no separate "add question to an
     existing draft" endpoint),
     `PATCH /api/forms/:formId/versions/:versionId` (the
     `publication_status` state machine: DRAFT→OPEN, OPEN→CLOSED or
     REVOKED, terminal states reject further transitions; publishing
     computes a SHA-256 `content_hash` over the frozen question
     structure),
     `POST /api/forms/:formId/versions/:versionId/grants` (creates a
     public access token — the **plaintext token is returned exactly
     once** in this response; only its SHA-256 hash is ever persisted),
     `PATCH /api/grants/:grantId` (revoke).
   - **Public, unauthenticated** — `GET /api/public/forms/:token`,
     `POST /api/public/forms/:token/responses`: deliberately mounted
     with no `authenticate`/`requireRole` middleware, per FR-012
     ("stakeholder submits via a shared link without logging in"). The
     token itself (verified via SHA-256 hash lookup) is the only gate.
     `case_id` on a submitted response is always derived server-side
     from the form's own owning Case — never accepted from the
     unauthenticated caller — which both satisfies the
     `rt_check_form_response_case` trigger and the explicit security
     requirement that a public submitter can't assert which Case
     they're submitting to. A grant's not-found/revoked/expired states
     are never distinguished in the response, matching
     `authenticate.ts`'s non-enumerable-session-failure principle.
   - `GET /api/cases/:caseId/form-responses?status=...`,
     `GET/PATCH /api/form-responses/:responseId` — the FR-013 review
     queue. Reviewing a response only updates `review_status`; it never
     touches Evidence — turning a reviewed response into Evidence is a
     separate, explicit BA action in the Evidence module (P2-B), never
     implied by marking a response REVIEWED.

### P2-B — Evidence, Evidence Review, Evidence Confirmation, Business Decision

1. Apply `migrations/010_grant_evidence_decision_infra.sql` on Machine
   A, after 009. `evidence.evidence_id` and
   `business_decisions.decision_id` both carry the `entity_identities`
   FK (confirmed in the same 13-table repair migration list as the
   Requirement/AC group), so both use
   `registerEntity()`/`createRevision()`. `evidence_review_records` and
   `evidence_confirmation_records` do NOT carry that FK themselves, but
   DO carry a composite FK (from
   `20261022080501_repair_schema_integrity.sql`) into
   `entity_revisions(entity_id, entity_revision_id)` — every
   review/confirmation event must pin a real, existing revision of that
   specific Evidence row. Both are append-only (`SELECT, INSERT` only,
   no `UPDATE`/`DELETE`).
2. New endpoints:
   - `GET/POST /api/cases/:caseId/evidence`, `GET /api/evidence/:id` —
     create an Evidence row (`evidence_status` defaults to
     `UNCONFIRMED`, `review_status` to `PENDING_REVIEW`).
   - `POST /api/evidence/:id/reviews` — records a review event and
     mirrors `review_outcome` onto `evidence.review_status`, but
     **deliberately never touches `evidence_status`** — per the
     Evidence Quality Standard (Framework section 0.6), Reviewed ≠
     Confirmed. The review always pins the evidence's current
     (latest) revision, resolved server-side via `findLatestRevision()`
     — never accepted from the client.
   - `POST /api/evidence/:id/confirmations` — per FR-014 AC-03, a
     `CONFIRMED` outcome requires a currently-valid `authority_id`
     (checked against `authority_assignments.valid_from`/`valid_to` via
     `isAuthorityCurrentlyValid()`); only then does `evidence_status`
     move to `CONFIRMED`. `REJECTED`/`REQUIRES_CLARIFICATION` outcomes
     don't require an authority.
   - `GET/POST /api/cases/:caseId/decisions`,
     `PATCH /api/decisions/:id` — Business Decision, with
     `decision_outcome` (PROPOSED/AGREED/REJECTED/SUPERSEDED) and
     optional `effective_from`/`effective_to` (validated `to > from`
     when both given, matching the DB's own CHECK). See P2-C below for
     what happens when `source_evidence_id` is supplied at creation.

### P2-C — Traceability extension

1. Apply `migrations/011_seed_relation_types.sql` (seeds
   `EVIDENCE_SUPPORTS_DECISION` and `DECISION_SUPPORTS_REQUIREMENT`
   RELATION_TYPE definitions — the only 2 with a concrete, approved use
   case; no other relation type is invented) and
   `migrations/012_grant_entity_identities_select.sql` on Machine A,
   after 010.
2. **Regression caught by live integration test, fixed the same way as
   the 006/008 bugs**: migration 005 (Phase 6 P1a) deliberately granted
   `app_backend` only `INSERT` on `entity_identities`, since at the
   time nothing read the table directly — its own comment said exactly
   that, and to add `SELECT` later "if a future module needs to query
   it directly". The generic Traceability API written for this batch
   (`findEntityType()`, validating a relation's source/target against
   the RELATION_TYPE's declared roles) is exactly that future module —
   caught as `permission denied for table entity_identities` on the
   live suite, fixed by migration 012 (`GRANT SELECT` + matching RLS
   policy, nothing else changed).
3. `src/modules/traceability/service.ts` — the generic Traceability
   API (`POST /api/relations`, body `{relation_type_code,
   source_entity_id, target_entity_id}`). Validates, in order: the
   relation type is a real `ACTIVE` RELATION_TYPE definition; both
   entities exist and carry the `entity_type` the relation type's
   `source_role`/`target_role` declare; a same-Case ownership check is
   written but currently a no-op in practice (neither seeded relation
   type requires it — both are deliberately cross-Case-eligible per the
   Data Dictionary's own note — kept in place for a future relation
   type that does require it, with no new enforcement code needed at
   that point); no existing `ACTIVE` relation of the same type already
   connects the same ordered (source, target) pair.
   `GET /api/entities/:entityId/relations` — the read-only lookup
   (FR-016 AC-01), deliberately not filtered by Case.
4. `DECISION_SUPPORTS_REQUIREMENT` is created by a BA directly through
   this generic API — there is no dedicated endpoint for it under
   `/requirements`. `EVIDENCE_SUPPORTS_DECISION` is instead
   auto-created inside `createDecisionService`'s own transaction
   whenever `source_evidence_id` is supplied at Business Decision
   creation, since `business_decisions` already carries that column at
   creation time and the relation should always exist alongside it —
   not as a separate manual step.
5. **Explicit finding, not a silent gap**: the instruction to "sync the
   relation when the Evidence source is updated" has no applicable code
   path in the current schema/code — `updateDecision()` (see
   `src/modules/business-decisions/repository.ts`) never updates
   `source_evidence_id`; it is immutable after creation. Since a
   Decision's evidence source can never change, the
   `EVIDENCE_SUPPORTS_DECISION` relation never needs to be re-pointed
   or retired. Making `source_evidence_id` mutable would be a
   schema/business-rule change outside this batch's approved scope.

### P2-D — Structural Validation (minimal)

1. Apply `migrations/013_grant_validation_infra.sql` on Machine A,
   after 012. Grants/policies for 4 tables
   (`baseline_manifests`, `manifest_items`, `validation_runs`,
   `validation_results`) whose creation migration is not present in
   this repo's local `migrations/` directory — their DDL (columns,
   CHECKs, FKs, and all 3 governing trigger functions'
   `pg_get_functiondef` source) was read directly off Supabase Cloud
   before writing this migration or any repository code, per the same
   practice used for every prior "schema not in this repo" batch. Also
   seeds exactly 3 `CHECK_RULE` definitions — see migration 013's own
   comment for the full schema record and the exact write-order
   constraints 3 triggers impose (`rt_guard_manifest_update`:
   DRAFT→FROZEN is a one-way, one-time transition, nothing about a
   frozen manifest can ever be updated/deleted again;
   `rt_guard_manifest_item`: manifest_items can only be
   inserted/changed while the manifest is still DRAFT;
   `rt_check_manifest_case`: a validation_runs row's `case_id` must
   match its manifest's `case_id`, enforced by always deriving it
   server-side from the manifest just created, never a second
   independent client input).
2. `POST /api/cases/:caseId/validation-runs` — creates a DRAFT
   `baseline_manifests` row, pins every current Requirement's latest
   `entity_revisions` row as an `ENTITY_REVISION` `manifest_items` row,
   computes `manifest_sha256` over the sorted revision id set, then
   performs the single UPDATE that freezes the manifest (must happen
   strictly after all item inserts, per the trigger order above).
   Creates a `validation_runs` row (`RUNNING`), executes exactly 3
   structural checks, writes one `validation_results` row per finding,
   then updates the run to `COMPLETED`. No other check is invented
   beyond these 3, each traceable to an approved source:
   - **REQ_HAS_AC** — every Requirement currently in the Case must have
     ≥1 row in `acceptance_criteria` (FR-016/017's own AC-CHK family
     spirit).
   - **DISCOVERY_ANSWER_NOT_UNKNOWN_ON_COMPLETE** — no
     `discovery_answers` row tied to a `module_applications` row whose
     `application_status = 'COMPLETED'` may have `answer_status =
     'UNKNOWN'` (FR-011).
   - **INFORMATION_GAP_STILL_OPEN** — any `information_gaps` row still
     `OPEN`/`CLARIFYING` is surfaced as a `WARNING` finding. This check
     does **not** decide Case readiness itself — that synthesis is
     explicitly P3 Assessment's job.
   `GET /api/cases/:caseId/validation-runs`,
   `GET /api/validation-runs/:validationRunId` (includes its results)
   round out the module.
3. **Validation Finding vs. Issue vs. Information Gap — kept distinct
   by construction**: a `validation_results` row is always a
   point-in-time finding produced by one `CHECK_RULE` run against one
   `validation_runs` row; it is never the same record as the
   Information Gap it may reference (check #3 only *reads*
   `information_gaps` to report still-open ones — it never creates,
   updates, or resolves a gap), and this module never reads or writes
   `issues`/`issue_resolutions` at all (out of scope for P2, left for a
   later batch per the approved plan).
4. `npm run typecheck` and `npm test` — 77 tests total after P2
   (adds validation-only tests for Traceability's generic relation API
   and Structural Validation's 3 entry points), still no database
   connection required.
5. `npm run test:integration` — 196/196 passing, covering all of
   P2-A/B/C/D end-to-end against live Supabase Cloud, including the
   full Stakeholder → Form → public submission → BA review → Evidence
   → Confirmation → Business Decision → auto Traceability relation →
   generic Traceability API → Structural Validation run chain inside a
   single Case.

**Explicitly out of scope for P2, not silently dropped**: `issues`/
`issue_resolutions` (left for a later batch), any `CHECK_RULE` beyond
the 3 listed above, any `RELATION_TYPE` beyond the 2 listed above, and
any synthesis of overall Case readiness/Assessment (P3's job, not
Structural Validation's).

## What this does NOT do

- Does not use Supabase Auth, Edge Functions, or any dual-write back
  into `auth.users`.
- Does not touch any of the 50 approved business tables' FKs,
  triggers, or the `rt_ba_read` policy / `authenticated` grants.
- Does not change, call, or revoke `rt_create_case_with_request` /
  `rt_update_case` — they remain reachable via the old path until a
  later phase retires them.
- Does not grant `BYPASSRLS` or superuser to `app_backend`/`app_users`
  access, and does not grant anything on the other 44 business tables.
- Does not implement signup, password reset, OAuth, or any
  permission engine beyond the single `BA` role.
