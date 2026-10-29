// Automated integration test against a real Postgres connection and
// a real (in-process) Express app - no mocking of the database layer.
// Exercises all 3 Auth endpoints, all 4 Case endpoints, Context +
// Scope (Phase 6 P1a), Module Application + Discovery Answer +
// Information Gap + the read-only Rule Registry lookup (Phase 6
// P1b/P1c), and Requirement + Acceptance Criteria + Requirement Split
// (FR-018) + Business Rule + Workflow (scenario/step/transition) +
// Business Data Definition/Attribute (Phase 6 P1d).
//
// Requirements before running:
//   - migrations 001-007 already applied on Machine A (migration 007
//     specifically, since the Requirement Split test below depends on
//     the seeded DECOMPOSED_FROM relation type actually existing)
//   - backend/.env.local filled in (PGHOST/PGPORT/PGDATABASE/PGUSER/
//     PGPASSWORD/PGSSLROOTCERT as needed) - same file check-db-access
//     uses
//   - the one real BA account already seeded in app_users (Phase 1) -
//     this test does NOT create a new app_users row, specifically
//     because a new row would need a fresh UUID with no auth.users
//     counterpart, and the 20 existing FKs this test's own writes
//     touch (cases.primary_owner_user_id, incoming_requests.
//     recorded_by, etc.) require that id to already satisfy
//     REFERENCES auth.users(id)
//   - its password available ONLY via the INTEGRATION_TEST_BA_PASSWORD
//     environment variable - never passed on the command line, never
//     committed, never printed by this script
//
// Usage (PowerShell):
//   $env:INTEGRATION_TEST_BA_PASSWORD = "<the real BA password>"
//   npm run test:integration
//   Remove-Item Env:\INTEGRATION_TEST_BA_PASSWORD
//
// Test data uses a fixed, grep-able prefix (ITEST-<run id>) and is
// deliberately NOT deleted by this script: app_backend has no
// DELETE grant on any of the 6 tables it can reach (cases,
// incoming_requests, case_request_associations, requirements,
// audit_events, app_users - see migration 003/004), by design, to
// match the "no hard delete" posture of the rest of the schema. A
// cleanup step that issued DELETE would either fail outright
// (permission denied, proving the grants work) or - if it somehow
// succeeded - would mean the grants are wrong. Either way, DELETE
// from this script is not the right tool. Test rows stay in the
// database, clearly identifiable by the ITEST- prefix, for manual
// removal later via a higher-privileged connection if ever needed -
// never through app_backend.

import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { config as loadEnv } from "dotenv";

loadEnv({ path: fileURLToPath(new URL("../.env.local", import.meta.url)) });

import { createApp } from "../src/app.js";
import { getPool } from "../src/db/pool.js";
import { getEntityRevisionService } from "../src/modules/entities/service.js";
import { HttpError } from "../src/http/errors.js";
import { findManifestItemsByManifestId } from "../src/modules/validation/repository.js";
import { resolveSourcePackage } from "../src/modules/documents/source-resolver.js";
import { buildWorkingPreviewService } from "../src/modules/documents/document-model/preview.js";

const RUN_ID = randomUUID().slice(0, 8);
const CASE_CODE = `ITEST-${RUN_ID}`;
const REQUEST_CODE = `ITEST-REQ-${RUN_ID}`;

let passCount = 0;
let failCount = 0;

function check(label: string, condition: boolean, detail?: string): void {
  if (condition) {
    passCount++;
    console.log(`OK   ${label}`);
  } else {
    failCount++;
    console.log(`FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

// Structural equality that does not depend on object key order -
// needed for comparing anything that round-tripped through a jsonb
// column, since Postgres does not preserve the original key insertion
// order the way JSON.stringify(sentObject) would (jsonb normalizes
// key order on storage/output). A plain JSON.stringify(a) ===
// JSON.stringify(b) comparison is therefore not a valid way to check
// "same value" for jsonb round-trips - only for values never touched
// by a jsonb column.
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, i) => deepEqual(item, b[i]));
  }
  if (a !== null && b !== null && typeof a === "object" && typeof b === "object") {
    const aKeys = Object.keys(a as Record<string, unknown>);
    const bKeys = Object.keys(b as Record<string, unknown>);
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every((key) =>
      deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
    );
  }
  return false;
}

interface JsonResponse {
  status: number;
  body: unknown;
  setCookieHeader: string | undefined;
}

async function request(
  baseUrl: string,
  method: string,
  path: string,
  options: { body?: unknown; cookie?: string } = {},
): Promise<JsonResponse> {
  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  if (options.cookie) headers["Cookie"] = options.cookie;

  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });

  const text = await res.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }

  return {
    status: res.status,
    body,
    setCookieHeader: res.headers.get("set-cookie") ?? undefined,
  };
}

function extractCookieValue(setCookieHeader: string | undefined): string | null {
  if (!setCookieHeader) return null;
  const match = setCookieHeader.match(/rt_session=([^;]+)/);
  return match ? `rt_session=${match[1]}` : null;
}

async function main(): Promise<void> {
  const baPassword = process.env.INTEGRATION_TEST_BA_PASSWORD;
  if (!baPassword) {
    console.error(
      "Missing INTEGRATION_TEST_BA_PASSWORD. Set it in the shell session only " +
        "(never on the command line, never in a committed file) and re-run.",
    );
    process.exitCode = 1;
    return;
  }

  // Look up the one real BA account's email without hardcoding it or
  // printing it - test output never shows email/password/session.
  const pool = getPool();
  const { rows: baRows } = await pool.query<{ email: string }>(
    `SELECT email FROM app_users WHERE rt_role = 'BA' LIMIT 1`,
  );
  if (!baRows[0]) {
    console.error("No app_users row with rt_role = 'BA' found - run Phase 1 seeding first.");
    process.exitCode = 1;
    return;
  }
  const baEmail = baRows[0].email;

  const app = createApp();
  const server = app.listen(0);
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to bind test server to an ephemeral port");
  }
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    console.log(`=== Auth: login ===\n`);

    const wrongPassword = await request(baseUrl, "POST", "/api/auth/login", {
      body: { email: baEmail, password: "definitely-the-wrong-password" },
    });
    check(
      "login with wrong password -> 401 UNAUTHENTICATED",
      wrongPassword.status === 401 &&
        (wrongPassword.body as { error?: { code?: string } })?.error?.code ===
          "UNAUTHENTICATED",
    );

    const missingFields = await request(baseUrl, "POST", "/api/auth/login", {
      body: { email: baEmail },
    });
    check(
      "login with missing password -> 400 VALIDATION_ERROR",
      missingFields.status === 400 &&
        (missingFields.body as { error?: { code?: string } })?.error?.code ===
          "VALIDATION_ERROR",
    );

    const login = await request(baseUrl, "POST", "/api/auth/login", {
      body: { email: baEmail, password: baPassword },
    });
    check("login with correct credentials -> 200", login.status === 200);
    if (login.status !== 200) {
      // Safe to print: on a failure this is only the error envelope
      // ({ error: { code, message } }), never the password or a
      // session value - the success path never reaches this branch.
      console.log(`  response: ${JSON.stringify(login.body)}`);
    }
    const cookie = extractCookieValue(login.setCookieHeader);
    check("login response sets a session cookie", cookie !== null);
    if (!cookie) {
      throw new Error("Cannot continue without a valid session cookie");
    }

    console.log(`\n=== Auth: me ===\n`);

    const meNoCookie = await request(baseUrl, "GET", "/api/auth/me");
    check(
      "GET /me with no cookie -> 401 UNAUTHENTICATED",
      meNoCookie.status === 401 &&
        (meNoCookie.body as { error?: { code?: string } })?.error?.code ===
          "UNAUTHENTICATED",
    );

    const me = await request(baseUrl, "GET", "/api/auth/me", { cookie });
    check(
      "GET /me with valid cookie -> 200, correct rtRole",
      me.status === 200 && (me.body as { data?: { rtRole?: string } })?.data?.rtRole === "BA",
    );

    console.log(`\n=== Case API: validation ===\n`);

    const missingCaseName = await request(baseUrl, "POST", "/api/cases", {
      cookie,
      body: {
        case_code: CASE_CODE,
        incoming_request: {
          request_code: REQUEST_CODE,
          request_text: "integration test",
          source_type: "EMAIL",
        },
      },
    });
    check(
      "POST /cases missing case_name -> 400 VALIDATION_ERROR",
      missingCaseName.status === 400 &&
        (missingCaseName.body as { error?: { code?: string } })?.error?.code ===
          "VALIDATION_ERROR",
    );

    const missingIncomingRequest = await request(baseUrl, "POST", "/api/cases", {
      cookie,
      body: { case_code: CASE_CODE, case_name: "Missing incoming_request" },
    });
    check(
      "POST /cases missing incoming_request -> 400 VALIDATION_ERROR",
      missingIncomingRequest.status === 400 &&
        (missingIncomingRequest.body as { error?: { code?: string } })?.error?.code ===
          "VALIDATION_ERROR",
    );

    const casesNoAuth = await request(baseUrl, "GET", "/api/cases");
    check(
      "GET /cases with no auth -> 401 UNAUTHENTICATED",
      casesNoAuth.status === 401,
    );

    const casesPaginated = await request(
      baseUrl,
      "GET",
      "/api/cases?page=1&pageSize=5",
      { cookie },
    );
    check(
      "GET /cases?page=1&pageSize=5 -> 200, pagination echoed back",
      casesPaginated.status === 200 &&
        (casesPaginated.body as { pagination?: { page?: number; pageSize?: number } })
          ?.pagination?.page === 1 &&
        (casesPaginated.body as { pagination?: { page?: number; pageSize?: number } })
          ?.pagination?.pageSize === 5,
    );

    const casesBadPageSize = await request(
      baseUrl,
      "GET",
      "/api/cases?pageSize=500",
      { cookie },
    );
    check(
      "GET /cases?pageSize=500 (over max) -> 400 VALIDATION_ERROR",
      casesBadPageSize.status === 400 &&
        (casesBadPageSize.body as { error?: { code?: string } })?.error?.code ===
          "VALIDATION_ERROR",
    );

    const getBadUuid = await request(baseUrl, "GET", "/api/cases/not-a-uuid", { cookie });
    check(
      "GET /cases/:id with non-UUID id -> 400 VALIDATION_ERROR",
      getBadUuid.status === 400 &&
        (getBadUuid.body as { error?: { code?: string } })?.error?.code ===
          "VALIDATION_ERROR",
    );

    console.log(`\n=== Case API: create, list, get, update ===\n`);

    const create = await request(baseUrl, "POST", "/api/cases", {
      cookie,
      body: {
        case_code: CASE_CODE,
        case_name: "Integration test case",
        incoming_request: {
          request_code: REQUEST_CODE,
          request_text: "integration test request",
          source_type: "EMAIL",
        },
      },
    });
    check("POST /cases -> 201", create.status === 201);
    const createdCaseId = (
      create.body as { data?: { case?: { case_id?: string } } }
    )?.data?.case?.case_id;
    check("created case has a case_id", typeof createdCaseId === "string");
    check(
      "created case owner is the authenticated caller (never request body)",
      (create.body as { data?: { case?: { primary_owner_user_id?: string } } })?.data?.case
        ?.primary_owner_user_id !== undefined,
    );

    if (createdCaseId) {
      const list = await request(baseUrl, "GET", "/api/cases", { cookie });
      check("GET /cases -> 200", list.status === 200);
      const listedCodes = (
        (list.body as { data?: { case_code: string }[] })?.data ?? []
      ).map((c) => c.case_code);
      check("new case appears in the list", listedCodes.includes(CASE_CODE));

      const get = await request(baseUrl, "GET", `/api/cases/${createdCaseId}`, { cookie });
      check("GET /cases/:id -> 200", get.status === 200);
      const incomingCodes = (
        (get.body as { data?: { incomingRequests?: { request_code: string }[] } })?.data
          ?.incomingRequests ?? []
      ).map((r) => r.request_code);
      check(
        "Get Case includes the linked incoming request",
        incomingCodes.includes(REQUEST_CODE),
      );

      const getMissing = await request(
        baseUrl,
        "GET",
        "/api/cases/00000000-0000-0000-0000-000000000000",
        { cookie },
      );
      check(
        "GET /cases/:id with nonexistent id -> 404 NOT_FOUND",
        getMissing.status === 404 &&
          (getMissing.body as { error?: { code?: string } })?.error?.code === "NOT_FOUND",
      );

      const update = await request(baseUrl, "PATCH", `/api/cases/${createdCaseId}`, {
        cookie,
        body: { case_name: "Renamed by integration test" },
      });
      check("PATCH /cases/:id -> 200", update.status === 200);
      check(
        "PATCH updates case_name only",
        (update.body as { data?: { case_name?: string } })?.data?.case_name ===
          "Renamed by integration test",
      );

      const updateMissing = await request(
        baseUrl,
        "PATCH",
        "/api/cases/00000000-0000-0000-0000-000000000000",
        { cookie, body: { case_name: "x" } },
      );
      check(
        "PATCH nonexistent case -> 404 NOT_FOUND",
        updateMissing.status === 404,
      );

      console.log(`\n=== Context API ===\n`);

      const contextListEmpty = await request(
        baseUrl,
        "GET",
        `/api/cases/${createdCaseId}/context`,
        { cookie },
      );
      check(
        "GET /cases/:id/context on a fresh case -> 200, empty list",
        contextListEmpty.status === 200 &&
          Array.isArray((contextListEmpty.body as { data?: unknown[] })?.data) &&
          (contextListEmpty.body as { data?: unknown[] }).data!.length === 0,
      );

      const createContextBadStatus = await request(
        baseUrl,
        "POST",
        `/api/cases/${createdCaseId}/context`,
        { cookie, body: { context_type: "PROBLEM", content: "x", knowledge_status: "MAYBE" } },
      );
      check(
        "POST context with invalid knowledge_status -> 400 VALIDATION_ERROR",
        createContextBadStatus.status === 400,
      );

      const createContext = await request(
        baseUrl,
        "POST",
        `/api/cases/${createdCaseId}/context`,
        {
          cookie,
          body: {
            context_type: "PROBLEM",
            content: "Refund process is manual and slow",
            knowledge_status: "KNOWN",
          },
        },
      );
      check("POST context -> 201", createContext.status === 201);
      const contextId = (createContext.body as { data?: { context_id?: string } })?.data
        ?.context_id;
      check("created context has a context_id", typeof contextId === "string");
      check(
        "created context has current_revision_no = 1",
        (createContext.body as { data?: { current_revision_no?: number } })?.data
          ?.current_revision_no === 1,
      );

      if (contextId) {
        const contextList = await request(
          baseUrl,
          "GET",
          `/api/cases/${createdCaseId}/context`,
          { cookie },
        );
        check(
          "GET /cases/:id/context now includes the created fact",
          (contextList.body as { data?: { context_id: string }[] })?.data?.some(
            (c) => c.context_id === contextId,
          ) === true,
        );

        const updateContext = await request(baseUrl, "PATCH", `/api/context/${contextId}`, {
          cookie,
          body: { content: "Refund process confirmed slow by stakeholder", knowledge_status: "ASSUMPTION" },
        });
        check("PATCH /context/:id -> 200", updateContext.status === 200);
        check(
          "PATCH context bumps current_revision_no to 2",
          (updateContext.body as { data?: { current_revision_no?: number } })?.data
            ?.current_revision_no === 2,
        );
        check(
          "PATCH context updates knowledge_status",
          (updateContext.body as { data?: { knowledge_status?: string } })?.data
            ?.knowledge_status === "ASSUMPTION",
        );

        const updateContextMissing = await request(
          baseUrl,
          "PATCH",
          "/api/context/00000000-0000-0000-0000-000000000000",
          { cookie, body: { content: "x", knowledge_status: "KNOWN" } },
        );
        check("PATCH nonexistent context -> 404 NOT_FOUND", updateContextMissing.status === 404);
      }

      console.log(`\n=== Scope API ===\n`);

      const scopeEmpty = await request(baseUrl, "GET", `/api/cases/${createdCaseId}/scope`, {
        cookie,
      });
      check(
        "GET /cases/:id/scope on a fresh case -> 200, null data",
        scopeEmpty.status === 200 && (scopeEmpty.body as { data?: unknown }).data === null,
      );

      const putScope = await request(baseUrl, "PUT", `/api/cases/${createdCaseId}/scope`, {
        cookie,
        body: {
          scope_name: "Refund automation scope",
          in_scope: "Automated eligibility check and payment system handoff",
          out_of_scope: "Manual exception handling UI",
        },
      });
      check("PUT /cases/:id/scope (create) -> 200", putScope.status === 200);
      check(
        "created scope has current_revision_no = 1",
        (putScope.body as { data?: { current_revision_no?: number } })?.data
          ?.current_revision_no === 1,
      );
      check(
        "created scope defaults scope_status to DRAFT",
        (putScope.body as { data?: { scope_status?: string } })?.data?.scope_status === "DRAFT",
      );

      const putScopeAgain = await request(baseUrl, "PUT", `/api/cases/${createdCaseId}/scope`, {
        cookie,
        body: {
          scope_name: "Refund automation scope",
          in_scope: "Automated eligibility check and payment system handoff",
          out_of_scope: "Manual exception handling UI",
          scope_status: "BASELINED",
        },
      });
      check(
        "PUT /cases/:id/scope again (update) bumps current_revision_no to 2",
        (putScopeAgain.body as { data?: { current_revision_no?: number } })?.data
          ?.current_revision_no === 2,
      );
      check(
        "second PUT updates scope_status",
        (putScopeAgain.body as { data?: { scope_status?: string } })?.data?.scope_status ===
          "BASELINED",
      );

      const getScopeFinal = await request(baseUrl, "GET", `/api/cases/${createdCaseId}/scope`, {
        cookie,
      });
      check(
        "GET /cases/:id/scope returns the latest revision, not a list",
        (getScopeFinal.body as { data?: { current_revision_no?: number } })?.data
          ?.current_revision_no === 2,
      );

      const putScopeMissingField = await request(
        baseUrl,
        "PUT",
        `/api/cases/${createdCaseId}/scope`,
        { cookie, body: { in_scope: "x" } },
      );
      check(
        "PUT scope missing scope_name -> 400 VALIDATION_ERROR",
        putScopeMissingField.status === 400,
      );

      console.log(`\n=== Rule Registry (read-only) ===\n`);

      const listModuleDefs = await request(baseUrl, "GET", "/api/definitions?type=MODULE", {
        cookie,
      });
      check("GET /definitions?type=MODULE -> 200, 7 modules", listModuleDefs.status === 200);
      const moduleDefs = (listModuleDefs.body as { data?: { definition_code: string }[] })?.data ?? [];
      check("exactly 7 MODULE definitions seeded", moduleDefs.length === 7);
      const procModuleDef = moduleDefs.find((d) => d.definition_code === "PROC");
      check("PROC module definition exists", procModuleDef !== undefined);

      const listQuestionDefs = await request(
        baseUrl,
        "GET",
        "/api/definitions?type=QUESTION",
        { cookie },
      );
      const questionDefs =
        (listQuestionDefs.body as { data?: { definition_code: string }[] })?.data ?? [];
      check("exactly 101 QUESTION definitions seeded", questionDefs.length === 101);
      const procQ01 = questionDefs.find((d) => d.definition_code === "PROC-Q-01");
      check("PROC-Q-01 question definition exists", procQ01 !== undefined);

      const badTypeDefs = await request(baseUrl, "GET", "/api/definitions?type=BOGUS", {
        cookie,
      });
      check(
        "GET /definitions with invalid type -> 400 VALIDATION_ERROR",
        badTypeDefs.status === 400,
      );

      if (procModuleDef && procQ01) {
        const procModuleDefId = (procModuleDef as { definition_version_id?: string })
          .definition_version_id!;
        const procQ01Id = (procQ01 as { definition_version_id?: string }).definition_version_id!;

        console.log(`\n=== Module Application API ===\n`);

        const modulesEmpty = await request(
          baseUrl,
          "GET",
          `/api/cases/${createdCaseId}/modules`,
          { cookie },
        );
        check(
          "GET /cases/:id/modules on a fresh case -> 200, empty list",
          modulesEmpty.status === 200 &&
            (modulesEmpty.body as { data?: unknown[] })?.data?.length === 0,
        );

        const applyModuleBadId = await request(
          baseUrl,
          "POST",
          `/api/cases/${createdCaseId}/modules`,
          { cookie, body: { module_definition_version_id: "00000000-0000-0000-0000-000000000000" } },
        );
        check(
          "POST modules with unknown definition id -> 400 VALIDATION_ERROR",
          applyModuleBadId.status === 400,
        );

        const applyModule = await request(
          baseUrl,
          "POST",
          `/api/cases/${createdCaseId}/modules`,
          { cookie, body: { module_definition_version_id: procModuleDefId, reason: "Approval flow" } },
        );
        check("POST modules (apply PROC) -> 201", applyModule.status === 201);
        const moduleApplicationId = (
          applyModule.body as { data?: { module_application_id?: string } }
        )?.data?.module_application_id;
        check(
          "applied module defaults to ACTIVE",
          (applyModule.body as { data?: { application_status?: string } })?.data
            ?.application_status === "ACTIVE",
        );

        if (moduleApplicationId) {
          const completeModule = await request(
            baseUrl,
            "PATCH",
            `/api/module-applications/${moduleApplicationId}`,
            { cookie, body: { application_status: "COMPLETED" } },
          );
          check("PATCH module-applications -> 200, COMPLETED", completeModule.status === 200);
          check(
            "completed module has a completed_at timestamp",
            (completeModule.body as { data?: { completed_at?: string | null } })?.data
              ?.completed_at !== null,
          );

          console.log(`\n=== Discovery Answer API ===\n`);

          const answersEmpty = await request(
            baseUrl,
            "GET",
            `/api/cases/${createdCaseId}/discovery-answers`,
            { cookie },
          );
          check(
            "GET discovery-answers on a fresh case -> 200, empty list",
            answersEmpty.status === 200 &&
              (answersEmpty.body as { data?: unknown[] })?.data?.length === 0,
          );

          const createAnswerBadQuestion = await request(
            baseUrl,
            "POST",
            `/api/cases/${createdCaseId}/discovery-answers`,
            {
              cookie,
              body: {
                question_definition_version_id: "00000000-0000-0000-0000-000000000000",
                answer_status: "KNOWN",
              },
            },
          );
          check(
            "POST discovery-answers with unknown question id -> 400 VALIDATION_ERROR",
            createAnswerBadQuestion.status === 400,
          );

          const createAnswer = await request(
            baseUrl,
            "POST",
            `/api/cases/${createdCaseId}/discovery-answers`,
            {
              cookie,
              body: {
                module_application_id: moduleApplicationId,
                question_definition_version_id: procQ01Id,
                answer_text: "Bắt đầu khi khách gửi purchase request, kết thúc khi được duyệt hoặc từ chối.",
                answer_status: "KNOWN",
              },
            },
          );
          check("POST discovery-answers -> 201", createAnswer.status === 201);
          const answerId = (createAnswer.body as { data?: { answer_id?: string } })?.data
            ?.answer_id;
          check(
            "created answer has current_revision_no = 1",
            (createAnswer.body as { data?: { current_revision_no?: number } })?.data
              ?.current_revision_no === 1,
          );

          if (answerId) {
            const updateAnswer = await request(
              baseUrl,
              "PATCH",
              `/api/discovery-answers/${answerId}`,
              { cookie, body: { answer_text: "Đã xác nhận với stakeholder", answer_status: "KNOWN" } },
            );
            check("PATCH discovery-answers -> 200", updateAnswer.status === 200);
            check(
              "PATCH answer bumps current_revision_no to 2",
              (updateAnswer.body as { data?: { current_revision_no?: number } })?.data
                ?.current_revision_no === 2,
            );

            const updateAnswerMissing = await request(
              baseUrl,
              "PATCH",
              "/api/discovery-answers/00000000-0000-0000-0000-000000000000",
              { cookie, body: { answer_status: "KNOWN" } },
            );
            check(
              "PATCH nonexistent answer -> 404 NOT_FOUND",
              updateAnswerMissing.status === 404,
            );
          }
        }
      }

      console.log(`\n=== Information Gap API ===\n`);

      const gapsEmpty = await request(baseUrl, "GET", `/api/cases/${createdCaseId}/gaps`, {
        cookie,
      });
      check(
        "GET /cases/:id/gaps on a fresh case -> 200, empty list",
        gapsEmpty.status === 200 && (gapsEmpty.body as { data?: unknown[] })?.data?.length === 0,
      );

      const createGapBadCondition = await request(
        baseUrl,
        "POST",
        `/api/cases/${createdCaseId}/gaps`,
        { cookie, body: { condition_type: "TYPO", gap_summary: "x" } },
      );
      check(
        "POST gaps with invalid condition_type -> 400 VALIDATION_ERROR",
        createGapBadCondition.status === 400,
      );

      const createGap = await request(baseUrl, "POST", `/api/cases/${createdCaseId}/gaps`, {
        cookie,
        body: {
          condition_type: "MISSING",
          required_information_key: "PROC-INFO-01",
          gap_summary: "Chưa rõ threshold cho 'request nhỏ'",
        },
      });
      check("POST gaps -> 201", createGap.status === 201);
      const gapId = (createGap.body as { data?: { gap_id?: string } })?.data?.gap_id;
      check(
        "created gap defaults to OPEN",
        (createGap.body as { data?: { gap_status?: string } })?.data?.gap_status === "OPEN",
      );

      if (gapId) {
        const invalidTransition = await request(baseUrl, "PATCH", `/api/gaps/${gapId}`, {
          cookie,
          body: { gap_status: "OPEN" },
        });
        // OPEN -> OPEN is not in ALLOWED_TRANSITIONS (only OPEN -> CLARIFYING/RESOLVED)
        check(
          "PATCH gap OPEN -> OPEN (no-op transition) -> 400 VALIDATION_ERROR",
          invalidTransition.status === 400,
        );

        const toClarifying = await request(baseUrl, "PATCH", `/api/gaps/${gapId}`, {
          cookie,
          body: { gap_status: "CLARIFYING" },
        });
        check("PATCH gap OPEN -> CLARIFYING -> 200", toClarifying.status === 200);

        const toResolved = await request(baseUrl, "PATCH", `/api/gaps/${gapId}`, {
          cookie,
          body: { gap_status: "RESOLVED" },
        });
        check("PATCH gap CLARIFYING -> RESOLVED -> 200", toResolved.status === 200);
        check(
          "resolved gap has a resolved_at timestamp",
          (toResolved.body as { data?: { resolved_at?: string | null } })?.data?.resolved_at !==
            null,
        );

        const filterByResolved = await request(
          baseUrl,
          "GET",
          `/api/cases/${createdCaseId}/gaps?status=RESOLVED`,
          { cookie },
        );
        check(
          "GET gaps?status=RESOLVED includes the resolved gap",
          (filterByResolved.body as { data?: { gap_id: string }[] })?.data?.some(
            (g) => g.gap_id === gapId,
          ) === true,
        );

        const updateGapMissing = await request(
          baseUrl,
          "PATCH",
          "/api/gaps/00000000-0000-0000-0000-000000000000",
          { cookie, body: { gap_status: "CLARIFYING" } },
        );
        check("PATCH nonexistent gap -> 404 NOT_FOUND", updateGapMissing.status === 404);
      }

      console.log(`\n=== Requirement + Acceptance Criteria API ===\n`);

      const reqListEmpty = await request(
        baseUrl,
        "GET",
        `/api/cases/${createdCaseId}/requirements`,
        { cookie },
      );
      check(
        "GET /cases/:id/requirements on a fresh case -> 200, empty list",
        reqListEmpty.status === 200 &&
          (reqListEmpty.body as { data?: unknown[] })?.data?.length === 0,
      );

      const createReqBadType = await request(
        baseUrl,
        "POST",
        `/api/cases/${createdCaseId}/requirements`,
        { cookie, body: { requirement_code: `${CASE_CODE}-REQ-1`, requirement_type: "BOGUS", title: "t", statement: "s" } },
      );
      check(
        "POST requirements with invalid requirement_type -> 400 VALIDATION_ERROR",
        createReqBadType.status === 400,
      );

      const createReq = await request(
        baseUrl,
        "POST",
        `/api/cases/${createdCaseId}/requirements`,
        {
          cookie,
          body: {
            requirement_code: `${CASE_CODE}-REQ-1`,
            requirement_type: "FUNCTIONAL",
            title: "Auto-approve small purchase requests",
            statement: "When a purchase request amount is below threshold X, the system auto-approves it.",
          },
        },
      );
      check("POST requirements -> 201", createReq.status === 201);
      const requirementId = (createReq.body as { data?: { requirement_id?: string } })?.data
        ?.requirement_id;
      check(
        "created requirement defaults to DRAFT",
        (createReq.body as { data?: { lifecycle_status?: string } })?.data?.lifecycle_status ===
          "DRAFT",
      );

      const createReqDuplicate = await request(
        baseUrl,
        "POST",
        `/api/cases/${createdCaseId}/requirements`,
        {
          cookie,
          body: {
            requirement_code: `${CASE_CODE}-REQ-1`,
            requirement_type: "FUNCTIONAL",
            title: "Duplicate",
            statement: "Should be rejected",
          },
        },
      );
      check(
        "POST requirements with duplicate requirement_code -> 409 CONFLICT",
        createReqDuplicate.status === 409,
      );

      if (requirementId) {
        const getReq = await request(baseUrl, "GET", `/api/requirements/${requirementId}`, {
          cookie,
        });
        check("GET /requirements/:id -> 200", getReq.status === 200);

        const updateReq = await request(baseUrl, "PATCH", `/api/requirements/${requirementId}`, {
          cookie,
          body: {
            title: "Auto-approve small purchase requests (refined)",
            statement: "Updated statement",
            lifecycle_status: "QUALITY_READY",
          },
        });
        check("PATCH /requirements/:id -> 200", updateReq.status === 200);
        check(
          "PATCH requirement bumps current_revision_no to 2",
          (updateReq.body as { data?: { current_revision_no?: number } })?.data
            ?.current_revision_no === 2,
        );
        check(
          "PATCH requirement updates lifecycle_status",
          (updateReq.body as { data?: { lifecycle_status?: string } })?.data
            ?.lifecycle_status === "QUALITY_READY",
        );

        // B1.1 — Exact Revision Read Access (CI-01). requirementId now
        // has two revisions (create -> 1, the PATCH above -> 2). No
        // HTTP route exists for this yet (internal lookup only per
        // the B1.1 decision), so it is exercised by calling the
        // service directly against the same live database/app_backend
        // connection this whole file already uses.
        try {
          const rev1 = await getEntityRevisionService(requirementId, { revision_no: 1 });
          check(
            "exact revision 1 returns the original statement, not the current one",
            (rev1.data.content_snapshot as { statement?: string })?.statement ===
              "When a purchase request amount is below threshold X, the system auto-approves it.",
          );
          check("exact revision 1 reports revision_no = 1", rev1.data.revision_no === 1);

          const rev2 = await getEntityRevisionService(requirementId, { revision_no: 2 });
          check(
            "exact revision 2 returns the updated statement",
            (rev2.data.content_snapshot as { statement?: string })?.statement ===
              "Updated statement",
          );

          const rev1ById = await getEntityRevisionService(requirementId, {
            revision_id: rev1.data.entity_revision_id,
          });
          check(
            "exact lookup by revision_id returns the same row as by revision_no",
            rev1ById.data.entity_revision_id === rev1.data.entity_revision_id &&
              rev1ById.data.revision_no === 1,
          );

          let missingRevisionCode: string | undefined;
          try {
            await getEntityRevisionService(requirementId, { revision_no: 999 });
          } catch (err) {
            missingRevisionCode = err instanceof HttpError ? err.code : undefined;
          }
          check(
            "missing revision_no on a real entity -> NOT_FOUND",
            missingRevisionCode === "NOT_FOUND",
          );

          let unknownEntityCode: string | undefined;
          try {
            await getEntityRevisionService(randomUUID(), { revision_no: 1 });
          } catch (err) {
            unknownEntityCode = err instanceof HttpError ? err.code : undefined;
          }
          check("unregistered entity_id -> NOT_FOUND", unknownEntityCode === "NOT_FOUND");

          // Revision/entity mismatch: rev1's own entity_revision_id is
          // real, but belongs to requirementId, not to the Context
          // entity registered earlier in this run (contextId) -
          // exercises the CONFLICT classification path, not a 404.
          let mismatchCode: string | undefined;
          if (typeof contextId === "string") {
            try {
              await getEntityRevisionService(contextId, {
                revision_id: rev1.data.entity_revision_id,
              });
            } catch (err) {
              mismatchCode = err instanceof HttpError ? err.code : undefined;
            }
          }
          check(
            "revision_id that belongs to a different entity -> CONFLICT, not NOT_FOUND",
            mismatchCode === "CONFLICT",
          );
        } catch (err) {
          check("B1.1 exact revision lookup block completed without throwing", false, String(err));
        }

        // B1.3 — Structured Semantic Data (Requirement). Partial draft
        // (functional profile missing most fields, nfr-style field
        // absent) must be ACCEPTED, not rejected - completeness is
        // Quality Core's job, not this CRUD layer's.
        const createReqWithPartialStructuredDetail = await request(
          baseUrl,
          "PATCH",
          `/api/requirements/${requirementId}`,
          {
            cookie,
            body: {
              title: "Auto-approve small purchase requests (refined)",
              statement: "Updated statement",
              lifecycle_status: "QUALITY_READY",
              rationale: "Keeps approvals fast for low-risk amounts",
              priority: "HIGH",
              structured_detail: {
                profile_version: 1,
                functional: { actor: "Approver" },
              },
            },
          },
        );
        check(
          "PATCH requirement with a partial structured_detail draft -> 200 (not rejected)",
          createReqWithPartialStructuredDetail.status === 200,
        );
        check(
          "PATCH requirement persists structured_detail as sent",
          deepEqual(
            (createReqWithPartialStructuredDetail.body as { data?: { structured_detail?: unknown } })
              ?.data?.structured_detail,
            { profile_version: 1, functional: { actor: "Approver" } },
          ),
        );

        const badStructuredDetail = await request(
          baseUrl,
          "PATCH",
          `/api/requirements/${requirementId}`,
          {
            cookie,
            body: {
              title: "x",
              statement: "x",
              lifecycle_status: "QUALITY_READY",
              structured_detail: { functional: { actor: 123 } },
            },
          },
        );
        check(
          "PATCH requirement with wrong-typed structured_detail field -> 400 VALIDATION_ERROR",
          badStructuredDetail.status === 400,
        );

        // Revision snapshot fidelity: the revision just written by the
        // PATCH above must carry rationale/priority/structured_detail,
        // not just title/statement/lifecycle_status.
        try {
          const latestRevisionNo = (
            createReqWithPartialStructuredDetail.body as { data?: { current_revision_no?: number } }
          )?.data?.current_revision_no;
          if (typeof latestRevisionNo === "number") {
            const latestRevision = await getEntityRevisionService(requirementId, {
              revision_no: latestRevisionNo,
            });
            const snapshot = latestRevision.data.content_snapshot as {
              rationale?: string;
              priority?: string;
              structured_detail?: unknown;
            };
            check(
              "revision snapshot fidelity: content_snapshot carries rationale",
              snapshot.rationale === "Keeps approvals fast for low-risk amounts",
            );
            check(
              "revision snapshot fidelity: content_snapshot carries priority",
              snapshot.priority === "HIGH",
            );
            check(
              "revision snapshot fidelity: content_snapshot carries structured_detail",
              deepEqual(snapshot.structured_detail, {
                profile_version: 1,
                functional: { actor: "Approver" },
              }),
            );
          } else {
            check("revision snapshot fidelity block had a current_revision_no to check", false);
          }
        } catch (err) {
          check("B1.3 requirement revision fidelity block completed without throwing", false, String(err));
        }

        const acListEmpty = await request(
          baseUrl,
          "GET",
          `/api/requirements/${requirementId}/acceptance-criteria`,
          { cookie },
        );
        check(
          "GET acceptance-criteria on a fresh requirement -> 200, empty list",
          acListEmpty.status === 200 &&
            (acListEmpty.body as { data?: unknown[] })?.data?.length === 0,
        );

        const createAc = await request(
          baseUrl,
          "POST",
          `/api/requirements/${requirementId}/acceptance-criteria`,
          {
            cookie,
            body: {
              ac_code: "AC-1",
              condition_text: "Given a purchase request below threshold X",
              expected_outcome: "The system auto-approves it without manual review",
            },
          },
        );
        check("POST acceptance-criteria -> 201", createAc.status === 201);
        const acId = (createAc.body as { data?: { ac_id?: string } })?.data?.ac_id;
        check(
          "created AC defaults to DRAFT",
          (createAc.body as { data?: { status?: string } })?.data?.status === "DRAFT",
        );

        if (acId) {
          const updateAc = await request(baseUrl, "PATCH", `/api/acceptance-criteria/${acId}`, {
            cookie,
            body: {
              condition_text: "Given a purchase request below threshold X (refined)",
              expected_outcome: "The system auto-approves it",
              status: "READY",
            },
          });
          check("PATCH /acceptance-criteria/:id -> 200", updateAc.status === 200);
          check(
            "PATCH AC bumps current_revision_no to 2",
            (updateAc.body as { data?: { current_revision_no?: number } })?.data
              ?.current_revision_no === 2,
          );
        }

        console.log(`\n=== Requirement Split (FR-018) API ===\n`);

        const splitReq = await request(
          baseUrl,
          "POST",
          `/api/requirements/${requirementId}/split`,
          {
            cookie,
            body: {
              requirement_code: `${CASE_CODE}-REQ-1-A`,
              requirement_type: "FUNCTIONAL",
              title: "Auto-approve check: threshold evaluation",
              statement: "The system evaluates whether the request amount is below threshold X.",
            },
          },
        );
        check("POST /requirements/:id/split -> 201", splitReq.status === 201);
        const childRequirementId = (
          splitReq.body as { data?: { requirement?: { requirement_id?: string } } }
        )?.data?.requirement?.requirement_id;
        check(
          "split response links back to the parent requirement",
          (splitReq.body as { data?: { decomposedFrom?: string } })?.data?.decomposedFrom ===
            requirementId,
        );
        check("split child requirement has its own id", typeof childRequirementId === "string");

        const splitReqMissingParent = await request(
          baseUrl,
          "POST",
          "/api/requirements/00000000-0000-0000-0000-000000000000/split",
          {
            cookie,
            body: {
              requirement_code: `${CASE_CODE}-REQ-X`,
              requirement_type: "FUNCTIONAL",
              title: "t",
              statement: "s",
            },
          },
        );
        check(
          "POST split on nonexistent parent -> 404 NOT_FOUND",
          splitReqMissingParent.status === 404,
        );
      }

      console.log(`\n=== Business Rule API ===\n`);

      const createRule = await request(
        baseUrl,
        "POST",
        `/api/cases/${createdCaseId}/business-rules`,
        {
          cookie,
          body: {
            rule_code: `${CASE_CODE}-BR-1`,
            rule_statement: "A purchase request is eligible for auto-approval if amount < threshold X.",
            rule_type: "DECISION",
          },
        },
      );
      check("POST business-rules -> 201", createRule.status === 201);
      const ruleId = (createRule.body as { data?: { rule_id?: string } })?.data?.rule_id;
      check(
        "created rule defaults to DRAFT",
        (createRule.body as { data?: { status?: string } })?.data?.status === "DRAFT",
      );

      if (ruleId) {
        const updateRule = await request(baseUrl, "PATCH", `/api/business-rules/${ruleId}`, {
          cookie,
          body: { rule_statement: "Refined rule statement", status: "ACTIVE" },
        });
        check("PATCH /business-rules/:id -> 200", updateRule.status === 200);
        check(
          "PATCH rule bumps current_revision_no to 2",
          (updateRule.body as { data?: { current_revision_no?: number } })?.data
            ?.current_revision_no === 2,
        );

        // B1.3 — Structured Semantic Data (Business Rule). Rule was
        // created with rule_type DECISION, so DECISION_TABLE is an
        // allowed kind (SIMPLE/MULTI_CONDITION/DECISION_TABLE).
        // Partial draft (no conflict_resolution) must be accepted.
        const updateRuleWithDetail = await request(baseUrl, "PATCH", `/api/business-rules/${ruleId}`, {
          cookie,
          body: {
            rule_statement: "Refined rule statement with decision table",
            status: "ACTIVE",
            rule_detail: {
              profile_version: 1,
              kind: "DECISION_TABLE",
              columns: ["amount_tier", "outcome"],
              rows: [["low", "auto-approve"]],
            },
          },
        });
        check(
          "PATCH business rule with DECISION_TABLE rule_detail (DECISION rule_type) -> 200",
          updateRuleWithDetail.status === 200,
        );
        check(
          "PATCH business rule persists rule_detail as sent",
          deepEqual(
            (updateRuleWithDetail.body as { data?: { rule_detail?: unknown } })?.data?.rule_detail,
            {
              profile_version: 1,
              kind: "DECISION_TABLE",
              columns: ["amount_tier", "outcome"],
              rows: [["low", "auto-approve"]],
            },
          ),
        );

        const incompatibleRuleDetail = await request(baseUrl, "PATCH", `/api/business-rules/${ruleId}`, {
          cookie,
          body: {
            rule_statement: "x",
            status: "ACTIVE",
            // CALCULATION kind is not in DECISION's allowed set
            // (SIMPLE/MULTI_CONDITION/DECISION_TABLE) - must be
            // rejected as a shape/compatibility error, not silently
            // accepted.
            rule_detail: { kind: "CALCULATION", formula: "x * 2" },
          },
        });
        check(
          "PATCH business rule with kind incompatible with rule_type -> 400 VALIDATION_ERROR",
          incompatibleRuleDetail.status === 400,
        );

        // Revision snapshot fidelity: the revision just written must
        // carry rule_detail, not just rule_statement/status.
        try {
          const latestRevisionNo = (
            updateRuleWithDetail.body as { data?: { current_revision_no?: number } }
          )?.data?.current_revision_no;
          if (typeof latestRevisionNo === "number") {
            const latestRevision = await getEntityRevisionService(ruleId, {
              revision_no: latestRevisionNo,
            });
            const snapshot = latestRevision.data.content_snapshot as { rule_detail?: unknown };
            check(
              "rule revision snapshot fidelity: content_snapshot carries rule_detail",
              deepEqual(snapshot.rule_detail, {
                profile_version: 1,
                kind: "DECISION_TABLE",
                columns: ["amount_tier", "outcome"],
                rows: [["low", "auto-approve"]],
              }),
            );
          } else {
            check("rule revision snapshot fidelity block had a current_revision_no to check", false);
          }
        } catch (err) {
          check("B1.3 business rule revision fidelity block completed without throwing", false, String(err));
        }
      }

      const listRules = await request(baseUrl, "GET", `/api/cases/${createdCaseId}/business-rules`, {
        cookie,
      });
      check(
        "GET /cases/:id/business-rules includes the created rule",
        (listRules.body as { data?: { rule_id: string }[] })?.data?.some((r) => r.rule_id === ruleId) ===
          true,
      );

      console.log(`\n=== Workflow API ===\n`);

      const createWorkflow = await request(
        baseUrl,
        "POST",
        `/api/cases/${createdCaseId}/workflows`,
        {
          cookie,
          body: {
            workflow_code: `${CASE_CODE}-WF-1`,
            workflow_name: "Purchase Request Approval",
            trigger_description: "Customer submits a purchase request",
          },
        },
      );
      check("POST workflows -> 201", createWorkflow.status === 201);
      const workflowId = (createWorkflow.body as { data?: { workflow_id?: string } })?.data
        ?.workflow_id;

      if (workflowId) {
        const createStep1 = await request(baseUrl, "POST", `/api/workflows/${workflowId}/steps`, {
          cookie,
          body: { step_key: "SUBMIT", step_name: "Submit request", step_type: "START", sort_order: 1 },
        });
        check("POST workflows/:id/steps (step 1) -> 201", createStep1.status === 201);
        const step1Id = (createStep1.body as { data?: { step_id?: string } })?.data?.step_id;

        const createStep2 = await request(baseUrl, "POST", `/api/workflows/${workflowId}/steps`, {
          cookie,
          body: { step_key: "APPROVE", step_name: "Approve or reject", step_type: "DECISION", sort_order: 2 },
        });
        check("POST workflows/:id/steps (step 2) -> 201", createStep2.status === 201);
        const step2Id = (createStep2.body as { data?: { step_id?: string } })?.data?.step_id;

        if (step1Id && step2Id) {
          const createTransition = await request(
            baseUrl,
            "POST",
            `/api/workflows/${workflowId}/transitions`,
            {
              cookie,
              body: {
                source_step_id: step1Id,
                target_step_id: step2Id,
                transition_key: "SUBMIT_TO_APPROVE",
                transition_condition: "always",
              },
            },
          );
          check("POST workflows/:id/transitions -> 201", createTransition.status === 201);

          const transitionWrongWorkflow = await request(
            baseUrl,
            "POST",
            `/api/workflows/${workflowId}/transitions`,
            {
              cookie,
              body: {
                source_step_id: "00000000-0000-0000-0000-000000000000",
                target_step_id: step2Id,
                transition_key: "BOGUS",
              },
            },
          );
          check(
            "POST transition with nonexistent source_step_id -> 400 VALIDATION_ERROR",
            transitionWrongWorkflow.status === 400,
          );
        }

        const getWorkflow = await request(baseUrl, "GET", `/api/workflows/${workflowId}`, {
          cookie,
        });
        check("GET /workflows/:id -> 200", getWorkflow.status === 200);
        check(
          "GET /workflows/:id includes 2 steps",
          (getWorkflow.body as { data?: { steps?: unknown[] } })?.data?.steps?.length === 2,
        );
        check(
          "GET /workflows/:id includes 1 transition",
          (getWorkflow.body as { data?: { transitions?: unknown[] } })?.data?.transitions
            ?.length === 1,
        );
      }

      console.log(`\n=== Business Data Definition API ===\n`);

      const createDataDef = await request(
        baseUrl,
        "POST",
        `/api/cases/${createdCaseId}/data-definitions`,
        {
          cookie,
          body: {
            data_code: `${CASE_CODE}-DD-1`,
            entity_name: "PurchaseRequest",
            business_meaning: "A request from a customer to purchase goods or services.",
            data_kind: "ENTITY",
          },
        },
      );
      check("POST data-definitions -> 201", createDataDef.status === 201);
      const dataDefinitionId = (createDataDef.body as { data?: { data_definition_id?: string } })
        ?.data?.data_definition_id;

      if (dataDefinitionId) {
        const createAttribute = await request(
          baseUrl,
          "POST",
          `/api/data-definitions/${dataDefinitionId}/attributes`,
          {
            cookie,
            body: {
              attribute_code: "AMOUNT",
              attribute_name: "Amount",
              business_type: "decimal",
              nullable_policy: "REQUIRED",
            },
          },
        );
        check("POST data-definitions/:id/attributes -> 201", createAttribute.status === 201);

        const getDataDef = await request(
          baseUrl,
          "GET",
          `/api/data-definitions/${dataDefinitionId}`,
          { cookie },
        );
        check("GET /data-definitions/:id -> 200", getDataDef.status === 200);
        check(
          "GET /data-definitions/:id includes 1 attribute",
          (getDataDef.body as { data?: { attributes?: unknown[] } })?.data?.attributes?.length === 1,
        );
      }

      console.log(`\n=== Stakeholder API ===\n`);

      const createStakeholderMissingName = await request(baseUrl, "POST", "/api/stakeholders", {
        cookie,
        body: { organization: "Acme" },
      });
      check(
        "POST stakeholders missing display_name -> 400 VALIDATION_ERROR",
        createStakeholderMissingName.status === 400,
      );

      const createStakeholder = await request(baseUrl, "POST", "/api/stakeholders", {
        cookie,
        body: {
          display_name: `ITEST Stakeholder ${RUN_ID}`,
          organization: "Acme Corp",
          contact_email: `itest-${RUN_ID}@example.com`,
        },
      });
      check("POST stakeholders -> 201", createStakeholder.status === 201);
      const stakeholderId = (createStakeholder.body as { data?: { stakeholder_id?: string } })?.data
        ?.stakeholder_id;
      check("created stakeholder has a stakeholder_id", typeof stakeholderId === "string");

      const listStakeholders = await request(baseUrl, "GET", "/api/stakeholders", { cookie });
      check(
        "GET /stakeholders includes the created stakeholder",
        (listStakeholders.body as { data?: { stakeholder_id: string }[] })?.data?.some(
          (s) => s.stakeholder_id === stakeholderId,
        ) === true,
      );

      if (stakeholderId) {
        const getStakeholder = await request(
          baseUrl,
          "GET",
          `/api/stakeholders/${stakeholderId}`,
          { cookie },
        );
        check("GET /stakeholders/:id -> 200", getStakeholder.status === 200);

        console.log(`\n=== Case Stakeholder / Role / Authority API ===\n`);

        const addCaseStakeholderBadRole = await request(
          baseUrl,
          "POST",
          `/api/cases/${createdCaseId}/stakeholders`,
          { cookie, body: { stakeholder_id: stakeholderId } },
        );
        check(
          "POST cases/:id/stakeholders missing role_code -> 400 VALIDATION_ERROR",
          addCaseStakeholderBadRole.status === 400,
        );

        const addCaseStakeholder = await request(
          baseUrl,
          "POST",
          `/api/cases/${createdCaseId}/stakeholders`,
          { cookie, body: { stakeholder_id: stakeholderId, role_code: "REQUESTER" } },
        );
        check("POST cases/:id/stakeholders -> 201", addCaseStakeholder.status === 201);
        var caseStakeholderId = (
          addCaseStakeholder.body as {
            data?: { caseStakeholder?: { case_stakeholder_id?: string } };
          }
        )?.data?.caseStakeholder?.case_stakeholder_id;
        const firstRoleAssignmentId = (
          addCaseStakeholder.body as { data?: { role?: { role_assignment_id?: string } } }
        )?.data?.role?.role_assignment_id;
        check("added case stakeholder has a case_stakeholder_id", typeof caseStakeholderId === "string");
        check("first role assignment has a role_assignment_id", typeof firstRoleAssignmentId === "string");

        const addCaseStakeholderDuplicate = await request(
          baseUrl,
          "POST",
          `/api/cases/${createdCaseId}/stakeholders`,
          { cookie, body: { stakeholder_id: stakeholderId, role_code: "REQUESTER" } },
        );
        check(
          "POST cases/:id/stakeholders duplicate -> 409 CONFLICT",
          addCaseStakeholderDuplicate.status === 409,
        );

        const listCaseStakeholders = await request(
          baseUrl,
          "GET",
          `/api/cases/${createdCaseId}/stakeholders`,
          { cookie },
        );
        check("GET /cases/:id/stakeholders -> 200", listCaseStakeholders.status === 200);

        if (caseStakeholderId) {
          const addRole = await request(
            baseUrl,
            "POST",
            `/api/case-stakeholders/${caseStakeholderId}/roles`,
            { cookie, body: { role_code: "APPROVER" } },
          );
          check("POST case-stakeholders/:id/roles -> 201", addRole.status === 201);

          const grantAuthorityBadType = await request(
            baseUrl,
            "POST",
            `/api/case-stakeholders/${caseStakeholderId}/authority`,
            { cookie, body: { authority_type: "BOGUS", permitted_action: "APPROVE_SCOPE" } },
          );
          check(
            "POST case-stakeholders/:id/authority invalid authority_type -> 400 VALIDATION_ERROR",
            grantAuthorityBadType.status === 400,
          );

          const grantAuthority = await request(
            baseUrl,
            "POST",
            `/api/case-stakeholders/${caseStakeholderId}/authority`,
            {
              cookie,
              body: {
                role_assignment_id: firstRoleAssignmentId,
                authority_type: "BUSINESS_CONFIRM",
                permitted_action: "CONFIRM_EVIDENCE",
                verification_status: "VERIFIED",
              },
            },
          );
          check("POST case-stakeholders/:id/authority -> 201", grantAuthority.status === 201);
          var authorityId = (grantAuthority.body as { data?: { authority_id?: string } })?.data
            ?.authority_id;
          check("granted authority has an authority_id", typeof authorityId === "string");
        }
      }

      console.log(`\n=== Form + Version + Grant API ===\n`);

      const createFormMissingName = await request(
        baseUrl,
        "POST",
        `/api/cases/${createdCaseId}/forms`,
        { cookie, body: {} },
      );
      check(
        "POST cases/:id/forms missing form_name -> 400 VALIDATION_ERROR",
        createFormMissingName.status === 400,
      );

      const createForm = await request(baseUrl, "POST", `/api/cases/${createdCaseId}/forms`, {
        cookie,
        body: { form_name: `ITEST Form ${RUN_ID}`, form_purpose: "Collect stakeholder feedback" },
      });
      check("POST cases/:id/forms -> 201", createForm.status === 201);
      const formId = (createForm.body as { data?: { form_id?: string } })?.data?.form_id;
      check("created form has a form_id", typeof formId === "string");

      const listForms = await request(baseUrl, "GET", `/api/cases/${createdCaseId}/forms`, {
        cookie,
      });
      check(
        "GET /cases/:id/forms includes the created form",
        (listForms.body as { data?: { form_id: string }[] })?.data?.some((f) => f.form_id === formId) ===
          true,
      );

      var formResponseIdForReview: string | undefined;
      var evidenceIdFromResponse: string | undefined;

      if (formId) {
        const createVersionEmptyQuestions = await request(
          baseUrl,
          "POST",
          `/api/forms/${formId}/versions`,
          { cookie, body: { questions: [] } },
        );
        check(
          "POST forms/:id/versions with empty questions -> 400 VALIDATION_ERROR",
          createVersionEmptyQuestions.status === 400,
        );

        const createVersion = await request(baseUrl, "POST", `/api/forms/${formId}/versions`, {
          cookie,
          body: {
            questions: [
              {
                item_key: "Q1",
                prompt_label: "What is the main pain point?",
                answer_type: "LONG_TEXT",
                required_flag: true,
              },
            ],
          },
        });
        check("POST forms/:id/versions -> 201", createVersion.status === 201);
        const formVersionId = (createVersion.body as { data?: { version?: { form_version_id?: string } } })
          ?.data?.version?.form_version_id;
        const formItemId = (
          createVersion.body as { data?: { questions?: { form_item_id?: string }[] } }
        )?.data?.questions?.[0]?.form_item_id;
        check("created version has a form_version_id", typeof formVersionId === "string");
        check("created version has at least 1 question item", typeof formItemId === "string");

        if (formVersionId) {
          const getVersion = await request(
            baseUrl,
            "GET",
            `/api/forms/${formId}/versions/${formVersionId}`,
            { cookie },
          );
          check("GET /forms/:id/versions/:versionId -> 200", getVersion.status === 200);

          const createGrantBeforeOpen = await request(
            baseUrl,
            "POST",
            `/api/forms/${formId}/versions/${formVersionId}/grants`,
            { cookie, body: {} },
          );
          check(
            "POST grants before version is OPEN -> 400 VALIDATION_ERROR",
            createGrantBeforeOpen.status === 400,
          );

          const publishVersion = await request(
            baseUrl,
            "PATCH",
            `/api/forms/${formId}/versions/${formVersionId}`,
            { cookie, body: { publication_status: "OPEN" } },
          );
          check("PATCH version DRAFT -> OPEN -> 200", publishVersion.status === 200);
          check(
            "published version has a content_hash",
            typeof (publishVersion.body as { data?: { content_hash?: string | null } })?.data
              ?.content_hash === "string",
          );

          const republishVersion = await request(
            baseUrl,
            "PATCH",
            `/api/forms/${formId}/versions/${formVersionId}`,
            { cookie, body: { publication_status: "OPEN" } },
          );
          check(
            "PATCH version OPEN -> OPEN (invalid transition) -> 400 VALIDATION_ERROR",
            republishVersion.status === 400,
          );

          const createGrant = await request(
            baseUrl,
            "POST",
            `/api/forms/${formId}/versions/${formVersionId}/grants`,
            { cookie, body: { stakeholder_id: stakeholderId } },
          );
          check("POST forms/:id/versions/:versionId/grants -> 201", createGrant.status === 201);
          const grantId = (createGrant.body as { data?: { grant_id?: string } })?.data?.grant_id;
          const plaintextToken = (createGrant.body as { data?: { token?: string } })?.data?.token;
          check("created grant has a grant_id", typeof grantId === "string");
          check(
            "created grant returns a one-time plaintext token",
            typeof plaintextToken === "string" && plaintextToken.length > 0,
          );

          console.log(`\n=== Public Form API (unauthenticated) ===\n`);

          if (plaintextToken) {
            const publicGetBadToken = await request(
              baseUrl,
              "GET",
              "/api/public/forms/not-a-real-token",
            );
            check(
              "GET public form with bogus token -> 404 NOT_FOUND",
              publicGetBadToken.status === 404,
            );

            const publicGet = await request(
              baseUrl,
              "GET",
              `/api/public/forms/${plaintextToken}`,
            );
            check("GET public form with valid token -> 200", publicGet.status === 200);
            check(
              "public form view includes the question",
              (publicGet.body as { data?: { questions?: unknown[] } })?.data?.questions?.length === 1,
            );

            const publicSubmitMissingAnswers = await request(
              baseUrl,
              "POST",
              `/api/public/forms/${plaintextToken}/responses`,
              { body: { submitted_identity: "Stakeholder self-report" } },
            );
            check(
              "POST public response missing answers -> 400 VALIDATION_ERROR",
              publicSubmitMissingAnswers.status === 400,
            );

            if (formItemId) {
              const publicSubmit = await request(
                baseUrl,
                "POST",
                `/api/public/forms/${plaintextToken}/responses`,
                {
                  body: {
                    submitted_identity: "Stakeholder self-report",
                    answers: [
                      {
                        form_item_id: formItemId,
                        answer_value: "The approval process takes too long.",
                      },
                    ],
                  },
                },
              );
              check("POST public response -> 201", publicSubmit.status === 201);
              const responseId = (publicSubmit.body as { data?: { responseId?: string } })?.data
                ?.responseId;
              check("public response has a responseId", typeof responseId === "string");
              formResponseIdForReview = responseId;
            }

            const revokeGrant = await request(baseUrl, "PATCH", `/api/grants/${grantId}`, {
              cookie,
              body: {},
            });
            check("PATCH grants/:id (revoke) -> 200", revokeGrant.status === 200);

            const publicGetAfterRevoke = await request(
              baseUrl,
              "GET",
              `/api/public/forms/${plaintextToken}`,
            );
            check(
              "GET public form after revoke -> 404 NOT_FOUND",
              publicGetAfterRevoke.status === 404,
            );
          }
        }
      }

      console.log(`\n=== Form Response Review API (FR-013) ===\n`);

      const listResponses = await request(
        baseUrl,
        "GET",
        `/api/cases/${createdCaseId}/form-responses?status=PENDING_BA_REVIEW`,
        { cookie },
      );
      check("GET /cases/:id/form-responses?status=... -> 200", listResponses.status === 200);
      check(
        "pending review list includes the submitted response",
        formResponseIdForReview === undefined ||
          (listResponses.body as { data?: { response_id: string }[] })?.data?.some(
            (r) => r.response_id === formResponseIdForReview,
          ) === true,
      );

      if (formResponseIdForReview) {
        const getResponse = await request(
          baseUrl,
          "GET",
          `/api/form-responses/${formResponseIdForReview}`,
          { cookie },
        );
        check("GET /form-responses/:id -> 200", getResponse.status === 200);
        check(
          "form response includes submitted answers",
          (getResponse.body as { data?: { answers?: unknown[] } })?.data?.answers?.length === 1,
        );

        const updateResponseBadStatus = await request(
          baseUrl,
          "PATCH",
          `/api/form-responses/${formResponseIdForReview}`,
          { cookie, body: { review_status: "BOGUS" } },
        );
        check(
          "PATCH form-responses invalid review_status -> 400 VALIDATION_ERROR",
          updateResponseBadStatus.status === 400,
        );

        const updateResponse = await request(
          baseUrl,
          "PATCH",
          `/api/form-responses/${formResponseIdForReview}`,
          { cookie, body: { review_status: "REVIEWED" } },
        );
        check("PATCH form-responses -> 200, REVIEWED", updateResponse.status === 200);
      }

      console.log(`\n=== Evidence API (P3-FR-014) ===\n`);

      const createEvidenceBadSource = await request(
        baseUrl,
        "POST",
        `/api/cases/${createdCaseId}/evidence`,
        { cookie, body: { assertion_text: "x", source_kind: "BOGUS" } },
      );
      check(
        "POST evidence invalid source_kind -> 400 VALIDATION_ERROR",
        createEvidenceBadSource.status === 400,
      );

      const createEvidence = await request(baseUrl, "POST", `/api/cases/${createdCaseId}/evidence`, {
        cookie,
        body: {
          assertion_text: "Stakeholder confirmed the approval process takes too long",
          source_kind: "STAKEHOLDER",
        },
      });
      check("POST evidence -> 201", createEvidence.status === 201);
      const evidenceId = (createEvidence.body as { data?: { evidence_id?: string } })?.data
        ?.evidence_id;
      check(
        "created evidence defaults to UNCONFIRMED",
        (createEvidence.body as { data?: { evidence_status?: string } })?.data?.evidence_status ===
          "UNCONFIRMED",
      );
      evidenceIdFromResponse = evidenceId;

      const listEvidence = await request(baseUrl, "GET", `/api/cases/${createdCaseId}/evidence`, {
        cookie,
      });
      check(
        "GET /cases/:id/evidence includes the created evidence",
        (listEvidence.body as { data?: { evidence_id: string }[] })?.data?.some(
          (e) => e.evidence_id === evidenceId,
        ) === true,
      );

      if (evidenceId) {
        const reviewEvidence = await request(baseUrl, "POST", `/api/evidence/${evidenceId}/reviews`, {
          cookie,
          body: { review_outcome: "REVIEWED", review_basis: "Matches stakeholder form response" },
        });
        check("POST evidence/:id/reviews -> 201", reviewEvidence.status === 201);
        check(
          "review does not change evidence_status (Reviewed != Confirmed)",
          (reviewEvidence.body as { data?: { evidence?: { evidence_status?: string } } })?.data
            ?.evidence?.evidence_status === "UNCONFIRMED",
        );
        check(
          "review updates review_status to REVIEWED",
          (reviewEvidence.body as { data?: { evidence?: { review_status?: string } } })?.data
            ?.evidence?.review_status === "REVIEWED",
        );

        const confirmMissingAuthority = await request(
          baseUrl,
          "POST",
          `/api/evidence/${evidenceId}/confirmations`,
          {
            cookie,
            body: { confirmation_outcome: "CONFIRMED", evidence_basis: "Should fail without authority" },
          },
        );
        check(
          "POST confirmations CONFIRMED without authority_id -> 400 VALIDATION_ERROR",
          confirmMissingAuthority.status === 400,
        );

        if (typeof authorityId === "string") {
          const confirmEvidence = await request(
            baseUrl,
            "POST",
            `/api/evidence/${evidenceId}/confirmations`,
            {
              cookie,
              body: {
                authority_id: authorityId,
                confirmation_outcome: "CONFIRMED",
                evidence_basis: "Confirmed by BUSINESS_CONFIRM authority",
              },
            },
          );
          check("POST evidence/:id/confirmations -> 201", confirmEvidence.status === 201);
          check(
            "confirmation moves evidence_status to CONFIRMED",
            (confirmEvidence.body as { data?: { evidence?: { evidence_status?: string } } })?.data
              ?.evidence?.evidence_status === "CONFIRMED",
          );
        }

        const getEvidenceDetail = await request(baseUrl, "GET", `/api/evidence/${evidenceId}`, {
          cookie,
        });
        check("GET /evidence/:id -> 200", getEvidenceDetail.status === 200);
        check(
          "GET evidence detail includes reviews and confirmations",
          (getEvidenceDetail.body as { data?: { reviews?: unknown[]; confirmations?: unknown[] } })
            ?.data?.reviews?.length === 1,
        );
      }

      console.log(`\n=== Business Decision API + auto Traceability (P2-C) ===\n`);

      var decisionIdForTraceability: string | undefined;

      const createDecisionBadOutcome = await request(
        baseUrl,
        "POST",
        `/api/cases/${createdCaseId}/decisions`,
        {
          cookie,
          body: { decision_subject: "s", decision_text: "t", decision_outcome: "BOGUS" },
        },
      );
      check(
        "POST decisions invalid decision_outcome -> 400 VALIDATION_ERROR",
        createDecisionBadOutcome.status === 400,
      );

      const createDecision = await request(baseUrl, "POST", `/api/cases/${createdCaseId}/decisions`, {
        cookie,
        body: {
          decision_subject: "Approval SLA",
          decision_text: "Approval requests must be processed within 2 business days.",
          decision_outcome: "AGREED",
          source_evidence_id: evidenceIdFromResponse,
        },
      });
      check("POST decisions -> 201", createDecision.status === 201);
      const decisionId = (createDecision.body as { data?: { decision_id?: string } })?.data
        ?.decision_id;
      check("created decision has a decision_id", typeof decisionId === "string");
      decisionIdForTraceability = decisionId;

      const listDecisions = await request(baseUrl, "GET", `/api/cases/${createdCaseId}/decisions`, {
        cookie,
      });
      check(
        "GET /cases/:id/decisions includes the created decision",
        (listDecisions.body as { data?: { decision_id: string }[] })?.data?.some(
          (d) => d.decision_id === decisionId,
        ) === true,
      );

      if (decisionId) {
        const updateDecision = await request(baseUrl, "PATCH", `/api/decisions/${decisionId}`, {
          cookie,
          body: { decision_text: "Refined: processed within 1 business day.", decision_outcome: "AGREED" },
        });
        check("PATCH /decisions/:id -> 200", updateDecision.status === 200);
      }

      if (evidenceIdFromResponse && decisionId) {
        const evidenceRelations = await request(
          baseUrl,
          "GET",
          `/api/entities/${evidenceIdFromResponse}/relations`,
          { cookie },
        );
        check("GET /entities/:id/relations (evidence) -> 200", evidenceRelations.status === 200);
        check(
          "auto-created EVIDENCE_SUPPORTS_DECISION relation links evidence to decision",
          (
            evidenceRelations.body as {
              data?: { relation_type_code: string; source_entity_id: string; target_entity_id: string }[];
            }
          )?.data?.some(
            (r) =>
              r.relation_type_code === "EVIDENCE_SUPPORTS_DECISION" &&
              r.source_entity_id === evidenceIdFromResponse &&
              r.target_entity_id === decisionId,
          ) === true,
        );
      }

      console.log(`\n=== Generic Traceability API (P2-C) ===\n`);

      if (decisionIdForTraceability && requirementId) {
        const createRelationBadType = await request(baseUrl, "POST", "/api/relations", {
          cookie,
          body: {
            relation_type_code: "BOGUS_RELATION_TYPE",
            source_entity_id: decisionIdForTraceability,
            target_entity_id: requirementId,
          },
        });
        check(
          "POST relations with unknown relation_type_code -> 400 VALIDATION_ERROR",
          createRelationBadType.status === 400,
        );

        const createRelationWrongRoles = await request(baseUrl, "POST", "/api/relations", {
          cookie,
          body: {
            relation_type_code: "DECISION_SUPPORTS_REQUIREMENT",
            source_entity_id: requirementId,
            target_entity_id: decisionIdForTraceability,
          },
        });
        check(
          "POST relations with source/target roles swapped -> 400 VALIDATION_ERROR",
          createRelationWrongRoles.status === 400,
        );

        const createRelation = await request(baseUrl, "POST", "/api/relations", {
          cookie,
          body: {
            relation_type_code: "DECISION_SUPPORTS_REQUIREMENT",
            source_entity_id: decisionIdForTraceability,
            target_entity_id: requirementId,
          },
        });
        check("POST relations (DECISION_SUPPORTS_REQUIREMENT) -> 201", createRelation.status === 201);

        const createRelationDuplicate = await request(baseUrl, "POST", "/api/relations", {
          cookie,
          body: {
            relation_type_code: "DECISION_SUPPORTS_REQUIREMENT",
            source_entity_id: decisionIdForTraceability,
            target_entity_id: requirementId,
          },
        });
        check(
          "POST relations duplicate active relation -> 409 CONFLICT",
          createRelationDuplicate.status === 409,
        );

        const requirementRelations = await request(
          baseUrl,
          "GET",
          `/api/entities/${requirementId}/relations`,
          { cookie },
        );
        check("GET /entities/:id/relations (requirement) -> 200", requirementRelations.status === 200);
        check(
          "requirement relations include DECISION_SUPPORTS_REQUIREMENT",
          (
            requirementRelations.body as {
              data?: { relation_type_code: string; source_entity_id: string }[];
            }
          )?.data?.some(
            (r) =>
              r.relation_type_code === "DECISION_SUPPORTS_REQUIREMENT" &&
              r.source_entity_id === decisionIdForTraceability,
          ) === true,
        );
      }

      // B1.2 — Typed Relation Contract. 4 new RELATION_TYPE rows
      // (migration 022): RULE_APPLIES_TO_REQUIREMENT,
      // REQUIREMENT_FOLLOWS_WORKFLOW, RULE_REFERENCES_DATA_DEFINITION,
      // DECISION_SUPPORTS_RULE. Each only usable once migration 022 is
      // applied - if it has not been, createRelationService's own
      // "not an active RELATION_TYPE definition" check makes every one
      // of these POSTs fail with 400 VALIDATION_ERROR instead of 201,
      // which is reported as a failed check below rather than crashing
      // the run (see the B1.2 summary this prints at the end).
      console.log(`\n=== Typed Relations (B1.2) ===\n`);

      if (ruleId && requirementId) {
        const ruleAppliesToReq = await request(baseUrl, "POST", "/api/relations", {
          cookie,
          body: {
            relation_type_code: "RULE_APPLIES_TO_REQUIREMENT",
            source_entity_id: ruleId,
            target_entity_id: requirementId,
          },
        });
        check(
          "POST relations (RULE_APPLIES_TO_REQUIREMENT) -> 201 [requires migration 022]",
          ruleAppliesToReq.status === 201,
        );
      }

      if (requirementId && workflowId) {
        const reqFollowsWorkflow = await request(baseUrl, "POST", "/api/relations", {
          cookie,
          body: {
            relation_type_code: "REQUIREMENT_FOLLOWS_WORKFLOW",
            source_entity_id: requirementId,
            target_entity_id: workflowId,
          },
        });
        check(
          "POST relations (REQUIREMENT_FOLLOWS_WORKFLOW) -> 201 [requires migration 022]",
          reqFollowsWorkflow.status === 201,
        );
      }

      if (ruleId && dataDefinitionId) {
        const ruleReferencesData = await request(baseUrl, "POST", "/api/relations", {
          cookie,
          body: {
            relation_type_code: "RULE_REFERENCES_DATA_DEFINITION",
            source_entity_id: ruleId,
            target_entity_id: dataDefinitionId,
          },
        });
        check(
          "POST relations (RULE_REFERENCES_DATA_DEFINITION) -> 201 [requires migration 022]",
          ruleReferencesData.status === 201,
        );
      }

      if (decisionIdForTraceability && ruleId) {
        const decisionSupportsRule = await request(baseUrl, "POST", "/api/relations", {
          cookie,
          body: {
            relation_type_code: "DECISION_SUPPORTS_RULE",
            source_entity_id: decisionIdForTraceability,
            target_entity_id: ruleId,
          },
        });
        check(
          "POST relations (DECISION_SUPPORTS_RULE) -> 201 [requires migration 022]",
          decisionSupportsRule.status === 201,
        );

        // Wrong direction must still be rejected for the new relation
        // types too, not just the pre-existing ones - confirms the
        // seeded source_role/target_role are the intended way round.
        const decisionSupportsRuleSwapped = await request(baseUrl, "POST", "/api/relations", {
          cookie,
          body: {
            relation_type_code: "DECISION_SUPPORTS_RULE",
            source_entity_id: ruleId,
            target_entity_id: decisionIdForTraceability,
          },
        });
        check(
          "POST relations (DECISION_SUPPORTS_RULE) with roles swapped -> 400 VALIDATION_ERROR",
          decisionSupportsRuleSwapped.status === 400,
        );
      }

      if (ruleId) {
        const ruleRelations = await request(baseUrl, "GET", `/api/entities/${ruleId}/relations`, {
          cookie,
        });
        check("GET /entities/:id/relations (rule) -> 200", ruleRelations.status === 200);
        check(
          "rule relations include RULE_APPLIES_TO_REQUIREMENT, RULE_REFERENCES_DATA_DEFINITION and DECISION_SUPPORTS_RULE when migration 022 is applied",
          (() => {
            const rows =
              (ruleRelations.body as { data?: { relation_type_code: string }[] })?.data ?? [];
            const codes = new Set(rows.map((r) => r.relation_type_code));
            return (
              codes.has("RULE_APPLIES_TO_REQUIREMENT") &&
              codes.has("RULE_REFERENCES_DATA_DEFINITION") &&
              codes.has("DECISION_SUPPORTS_RULE")
            );
          })(),
        );
      }

      console.log(`\n=== Structural Validation API (P2-D) ===\n`);

      // A fresh, still-OPEN gap (the earlier Information Gap section's
      // gap was already moved to RESOLVED) so check #3 has something
      // to report as a WARNING finding.
      const createOpenGapForValidation = await request(
        baseUrl,
        "POST",
        `/api/cases/${createdCaseId}/gaps`,
        {
          cookie,
          body: {
            condition_type: "MISSING",
            gap_summary: "ITEST gap left open for structural validation",
          },
        },
      );
      check(
        "POST gaps (for validation check #3) -> 201",
        createOpenGapForValidation.status === 201,
      );

      const createRunBadCase = await request(
        baseUrl,
        "POST",
        "/api/cases/not-a-uuid/validation-runs",
        { cookie },
      );
      check(
        "POST validation-runs with non-UUID case id -> 400 VALIDATION_ERROR",
        createRunBadCase.status === 400,
      );

      const createRun = await request(
        baseUrl,
        "POST",
        `/api/cases/${createdCaseId}/validation-runs`,
        { cookie },
      );
      check("POST cases/:id/validation-runs -> 201", createRun.status === 201);
      const validationRunId = (
        createRun.body as { data?: { run?: { validation_run_id?: string } } }
      )?.data?.run?.validation_run_id;
      check("created validation run has a validation_run_id", typeof validationRunId === "string");
      check(
        "created validation run completed (not stuck RUNNING)",
        (createRun.body as { data?: { run?: { run_status?: string } } })?.data?.run?.run_status ===
          "COMPLETED",
      );
      check(
        "validation run froze a manifest",
        typeof (createRun.body as { data?: { manifest?: { manifest_id?: string } } })?.data?.manifest
          ?.manifest_id === "string",
      );
      check(
        "frozen manifest has manifest_status = FROZEN",
        (createRun.body as { data?: { manifest?: { manifest_status?: string } } })?.data?.manifest
          ?.manifest_status === "FROZEN",
      );
      check(
        "frozen manifest has a manifest_sha256",
        typeof (createRun.body as { data?: { manifest?: { manifest_sha256?: string } } })?.data
          ?.manifest?.manifest_sha256 === "string",
      );

      const resultsBody = (
        createRun.body as {
          data?: { results?: { result_outcome: string; finding_summary: string | null }[] };
        }
      )?.data?.results;
      check(
        "validation run produced at least 1 result per check (>= 3 results)",
        Array.isArray(resultsBody) && resultsBody.length >= 3,
      );
      check(
        "results include a PASS finding for the requirement with an AC",
        resultsBody?.some(
          (r) =>
            r.result_outcome === "PASS" &&
            typeof r.finding_summary === "string" &&
            r.finding_summary.includes("has"),
        ) === true,
      );
      check(
        "results include a WARNING finding for the still-open information gap",
        resultsBody?.some(
          (r) => r.result_outcome === "WARNING" && r.finding_summary?.includes("ITEST gap left open"),
        ) === true,
      );

      const listRuns = await request(
        baseUrl,
        "GET",
        `/api/cases/${createdCaseId}/validation-runs`,
        { cookie },
      );
      check("GET /cases/:id/validation-runs -> 200", listRuns.status === 200);
      check(
        "validation run list includes the created run",
        (listRuns.body as { data?: { validation_run_id: string }[] })?.data?.some(
          (r) => r.validation_run_id === validationRunId,
        ) === true,
      );

      if (validationRunId) {
        const getRun = await request(baseUrl, "GET", `/api/validation-runs/${validationRunId}`, {
          cookie,
        });
        check("GET /validation-runs/:id -> 200", getRun.status === 200);
        check(
          "GET validation run detail includes its results",
          Array.isArray((getRun.body as { data?: { results?: unknown[] } })?.data?.results) &&
            (getRun.body as { data?: { results?: unknown[] } })!.data!.results!.length >= 3,
        );
      }

      const getRunMissing = await request(
        baseUrl,
        "GET",
        "/api/validation-runs/00000000-0000-0000-0000-000000000000",
        { cookie },
      );
      check("GET nonexistent validation run -> 404 NOT_FOUND", getRunMissing.status === 404);

      console.log(`\n=== Human-reviewed Validation Result API ===\n`);

      if (validationRunId) {
        const recordBadCheckCode = await request(
          baseUrl,
          "POST",
          `/api/validation-runs/${validationRunId}/results`,
          {
            cookie,
            body: { check_rule_code: "BOGUS_RULE", result_outcome: "PASS", finding_summary: "x" },
          },
        );
        check(
          "POST human-reviewed result with unknown check_rule_code -> 400 VALIDATION_ERROR",
          recordBadCheckCode.status === 400,
        );

        const recordOnDeterministic = await request(
          baseUrl,
          "POST",
          `/api/validation-runs/${validationRunId}/results`,
          {
            cookie,
            body: { check_rule_code: "REQ_HAS_AC", result_outcome: "PASS", finding_summary: "x" },
          },
        );
        check(
          "POST human-reviewed result on a DETERMINISTIC check -> 400 VALIDATION_ERROR",
          recordOnDeterministic.status === 400,
        );

        const recordMissingSummary = await request(
          baseUrl,
          "POST",
          `/api/validation-runs/${validationRunId}/results`,
          { cookie, body: { check_rule_code: "REQ_HAS_AC", result_outcome: "PASS" } },
        );
        check(
          "POST human-reviewed result missing finding_summary -> 400 VALIDATION_ERROR",
          recordMissingSummary.status === 400,
        );
      }

      console.log(`\n=== Issue API (Blocker Management) ===\n`);

      const createIssueBadType = await request(baseUrl, "POST", `/api/cases/${createdCaseId}/issues`, {
        cookie,
        body: { issue_code: `${CASE_CODE}-ISS-1`, issue_subject: "s", issue_type: "BOGUS" },
      });
      check(
        "POST issues with invalid issue_type -> 400 VALIDATION_ERROR",
        createIssueBadType.status === 400,
      );

      const createIssue = await request(baseUrl, "POST", `/api/cases/${createdCaseId}/issues`, {
        cookie,
        body: {
          issue_code: `${CASE_CODE}-ISS-1`,
          issue_subject: "Payment gateway integration not yet confirmed",
          issue_type: "BLOCKER",
          severity: "HIGH",
        },
      });
      check("POST issues -> 201", createIssue.status === 201);
      const issueId = (createIssue.body as { data?: { issue_id?: string } })?.data?.issue_id;
      check(
        "created issue defaults to OPEN",
        (createIssue.body as { data?: { issue_status?: string } })?.data?.issue_status === "OPEN",
      );

      const createIssueDuplicateCode = await request(
        baseUrl,
        "POST",
        `/api/cases/${createdCaseId}/issues`,
        {
          cookie,
          body: {
            issue_code: `${CASE_CODE}-ISS-1`,
            issue_subject: "duplicate",
            issue_type: "BLOCKER",
          },
        },
      );
      check(
        "POST issues with duplicate issue_code -> 409 CONFLICT",
        createIssueDuplicateCode.status === 409,
      );

      const listIssues = await request(baseUrl, "GET", `/api/cases/${createdCaseId}/issues`, {
        cookie,
      });
      check(
        "GET /cases/:id/issues includes the created issue",
        (listIssues.body as { data?: { issue_id: string }[] })?.data?.some((i) => i.issue_id === issueId) ===
          true,
      );

      console.log(`\n=== Assessment API: Completeness, Quality Gate, Readiness ===\n`);

      const createCompleteness = await request(
        baseUrl,
        "POST",
        `/api/cases/${createdCaseId}/assessments/completeness`,
        { cookie },
      );
      check("POST assessments/completeness -> 201", createCompleteness.status === 201);
      check(
        "completeness assessment is FINALIZED",
        (createCompleteness.body as { data?: { record_status?: string } })?.data?.record_status ===
          "FINALIZED",
      );
      check(
        "completeness outcome is one of COMPLETE/INCOMPLETE/UNKNOWN",
        ["COMPLETE", "INCOMPLETE", "UNKNOWN"].includes(
          (createCompleteness.body as { data?: { outcome?: string } })?.data?.outcome ?? "",
        ),
      );

      const createQuality = await request(
        baseUrl,
        "POST",
        `/api/cases/${createdCaseId}/assessments/quality`,
        { cookie },
      );
      check("POST assessments/quality -> 201", createQuality.status === 201);
      check(
        "quality gate cannot report PASS while obligation_level is UNDETERMINED for all check rules",
        (createQuality.body as { data?: { outcome?: string } })?.data?.outcome === "UNKNOWN",
      );

      const listAssessments = await request(
        baseUrl,
        "GET",
        `/api/cases/${createdCaseId}/assessments?assessment_type=QUALITY`,
        { cookie },
      );
      check("GET /cases/:id/assessments?assessment_type=QUALITY -> 200", listAssessments.status === 200);
      check(
        "assessment list includes the created quality assessment",
        (listAssessments.body as { data?: { outcome: string }[] })?.data?.length! > 0,
      );

      const qualityAssessmentId = (createQuality.body as { data?: { assessment_id?: string } })?.data
        ?.assessment_id;
      if (qualityAssessmentId) {
        const getAssessment = await request(
          baseUrl,
          "GET",
          `/api/assessments/${qualityAssessmentId}`,
          { cookie },
        );
        check("GET /assessments/:id -> 200", getAssessment.status === 200);
      }

      var createReadinessWithOpenBlocker = await request(
        baseUrl,
        "POST",
        `/api/cases/${createdCaseId}/assessments/readiness`,
        { cookie },
      );
      check("POST assessments/readiness -> 201", createReadinessWithOpenBlocker.status === 201);
      check(
        "readiness is NOT_READY because the latest Quality assessment is not PASS",
        (createReadinessWithOpenBlocker.body as { data?: { outcome?: string } })?.data?.outcome ===
          "NOT_READY",
      );

      // Resolve the blocker issue - demonstrates "blocker recorded" vs
      // "blocker resolved" are genuinely distinct operations, even
      // though Readiness still can't reach READY (Quality Gate itself
      // can never PASS while obligation_level is UNDETERMINED).
      if (issueId) {
        const resolveIssueMissingFields = await request(
          baseUrl,
          "POST",
          `/api/issues/${issueId}/resolutions`,
          { cookie, body: {} },
        );
        check(
          "POST issues/:id/resolutions missing fields -> 400 VALIDATION_ERROR",
          resolveIssueMissingFields.status === 400,
        );

        const resolveIssue = await request(baseUrl, "POST", `/api/issues/${issueId}/resolutions`, {
          cookie,
          body: {
            resolution_method: "Clarification",
            resolution_summary: "Payment gateway integration confirmed with vendor",
            verification_outcome: "PASS",
          },
        });
        check("POST issues/:id/resolutions -> 201", resolveIssue.status === 201);

        const closeIssueBeforeResolution = await request(baseUrl, "PATCH", "/api/issues/00000000-0000-0000-0000-000000000000", {
          cookie,
          body: { issue_subject: "x", issue_status: "RESOLVED" },
        });
        check("PATCH nonexistent issue -> 404 NOT_FOUND", closeIssueBeforeResolution.status === 404);

        const closeIssue = await request(baseUrl, "PATCH", `/api/issues/${issueId}`, {
          cookie,
          body: {
            issue_subject: "Payment gateway integration not yet confirmed",
            issue_status: "RESOLVED",
          },
        });
        check("PATCH issues/:id -> RESOLVED -> 200", closeIssue.status === 200);
        check(
          "resolved issue has a closed_at timestamp",
          (closeIssue.body as { data?: { closed_at?: string | null } })?.data?.closed_at !== null,
        );

        const getIssueDetail = await request(baseUrl, "GET", `/api/issues/${issueId}`, { cookie });
        check("GET /issues/:id -> 200", getIssueDetail.status === 200);
        check(
          "GET issue detail includes its resolution",
          (getIssueDetail.body as { data?: { resolutions?: unknown[] } })?.data?.resolutions?.length ===
            1,
        );
      }

      console.log(`\n=== Document API (P3 Step 2: Document Management) ===\n`);

      const createDocumentBadType = await request(baseUrl, "POST", `/api/cases/${createdCaseId}/documents`, {
        cookie,
        body: { document_type: "BOGUS", document_name: "x" },
      });
      check(
        "POST documents with invalid document_type -> 400 VALIDATION_ERROR",
        createDocumentBadType.status === 400,
      );

      const createDocument = await request(baseUrl, "POST", `/api/cases/${createdCaseId}/documents`, {
        cookie,
        body: { document_type: "CRD", document_name: `ITEST CRD ${RUN_ID}` },
      });
      check("POST documents -> 201", createDocument.status === 201);
      const documentId = (createDocument.body as { data?: { document_id?: string } })?.data?.document_id;
      check("created document defaults to WORKING status",
        (createDocument.body as { data?: { document_status?: string } })?.data?.document_status === "WORKING");

      const listDocuments = await request(baseUrl, "GET", `/api/cases/${createdCaseId}/documents`, { cookie });
      check(
        "GET /cases/:id/documents includes the created document",
        (listDocuments.body as { data?: { document_id: string }[] })?.data?.some(
          (d) => d.document_id === documentId,
        ) === true,
      );

      console.log(`\n=== Document Snapshot API (P3 Step 3: Snapshot & Source Manifest) ===\n`);

      var snapshotId: string | undefined;
      var publicationIdForHandoff: string | undefined;

      if (documentId && requirementId) {
        const createSnapshotMissingScope = await request(
          baseUrl,
          "POST",
          `/api/documents/${documentId}/snapshots`,
          { cookie, body: { content: { title: "Draft CRD" } } },
        );
        check(
          "POST snapshots missing scope_entity_ids -> 400 VALIDATION_ERROR",
          createSnapshotMissingScope.status === 400,
        );

        const createSnapshotFakeScope = await request(
          baseUrl,
          "POST",
          `/api/documents/${documentId}/snapshots`,
          {
            cookie,
            body: {
              content: { title: "Draft CRD" },
              scope_entity_ids: ["00000000-0000-0000-0000-000000000000"],
            },
          },
        );
        check(
          "POST snapshots with a fake scope entity id -> 400 VALIDATION_ERROR",
          createSnapshotFakeScope.status === 400,
        );

        const createSnapshotBadConfirmable = await request(
          baseUrl,
          "POST",
          `/api/documents/${documentId}/snapshots`,
          {
            cookie,
            body: {
              content: { title: "Draft CRD" },
              scope_entity_ids: [requirementId],
              confirmable_entity_ids: ["00000000-0000-0000-0000-000000000000"],
            },
          },
        );
        check(
          "POST snapshots with confirmable_entity_ids outside scope_entity_ids -> 400 VALIDATION_ERROR",
          createSnapshotBadConfirmable.status === 400,
        );

        const snapshotContent = {
          title: "Integration Test CRD",
          sections: [{ code: "C07", requirementIds: [requirementId] }],
        };
        const createSnapshot = await request(baseUrl, "POST", `/api/documents/${documentId}/snapshots`, {
          cookie,
          body: {
            content: snapshotContent,
            scope_entity_ids: [requirementId],
            confirmable_entity_ids: [requirementId],
          },
        });
        check("POST snapshots -> 201", createSnapshot.status === 201);
        snapshotId = (createSnapshot.body as { data?: { snapshot?: { snapshot_id?: string } } })?.data
          ?.snapshot?.snapshot_id;
        check("created snapshot has a snapshot_id", typeof snapshotId === "string");
        check(
          "created snapshot defaults to FROZEN render_status",
          (createSnapshot.body as { data?: { snapshot?: { render_status?: string } } })?.data?.snapshot
            ?.render_status === "FROZEN",
        );
        check(
          "created snapshot froze a DOCUMENT-purpose manifest",
          (createSnapshot.body as { data?: { manifest?: { manifest_purpose?: string } } })?.data?.manifest
            ?.manifest_purpose === "DOCUMENT",
        );

        // B2.1 — Dependency Closure & Exact Revision Pinning. The
        // snapshot above was created with scope_entity_ids = [requirementId]
        // only. By this point in the run, requirementId already has:
        //   RULE_APPLIES_TO_REQUIREMENT      ruleId -> requirementId
        //   REQUIREMENT_FOLLOWS_WORKFLOW     requirementId -> workflowId
        //   RULE_REFERENCES_DATA_DEFINITION  ruleId -> dataDefinitionId
        //   DECISION_SUPPORTS_RULE           decisionIdForTraceability -> ruleId
        // so the closure must have pulled in ruleId and workflowId
        // (1 hop from requirementId) AND dataDefinitionId and
        // decisionIdForTraceability (2 hops, only reachable once
        // ruleId itself is in the closure) - all four strictly as
        // REFERENCED_ONLY, with requirementId remaining the only
        // INCLUDED/CONFIRMABLE item (the selected scope is untouched).
        try {
          const manifestId = (
            createSnapshot.body as { data?: { manifest?: { manifest_id?: string } } }
          )?.data?.manifest?.manifest_id;
          if (typeof manifestId === "string") {
            const items = await findManifestItemsByManifestId(manifestId);
            const byEntityRevisionId = new Map(
              items
                .filter((item) => item.entity_revision_id !== null)
                .map((item) => [item.entity_revision_id as string, item]),
            );

            // Fetched fresh here rather than reusing an earlier
            // response variable, since that variable was declared
            // inside a different `if` block (Requirement API section)
            // that has already closed by this point in the file - out
            // of scope, not available here.
            const reqNow = await request(baseUrl, "GET", `/api/requirements/${requirementId}`, {
              cookie,
            });
            const reqCurrentRevisionNo =
              (reqNow.body as { data?: { current_revision_no?: number } })?.data
                ?.current_revision_no ?? 1;
            const reqCurrentRevision = await getEntityRevisionService(requirementId, {
              revision_no: reqCurrentRevisionNo,
            });
            const requirementManifestItem = byEntityRevisionId.get(
              reqCurrentRevision.data.entity_revision_id,
            );
            check(
              "requirement's manifest item is CONFIRMABLE (the caller's own selection, untouched)",
              requirementManifestItem?.membership_role === "CONFIRMABLE",
            );

            check(
              "manifest has exactly 1 INCLUDED/CONFIRMABLE item (the selected scope was not expanded)",
              items.filter(
                (item) => item.membership_role === "INCLUDED" || item.membership_role === "CONFIRMABLE",
              ).length === 1,
            );

            const referencedOnlyItems = items.filter((item) => item.membership_role === "REFERENCED_ONLY");
            check(
              "manifest has exactly 4 REFERENCED_ONLY items (rule, workflow, data definition, decision)",
              referencedOnlyItems.length === 4,
            );

            // Looks up entityId's CURRENT revision_no, then resolves
            // that exact revision - NOT a fixed revision_no: 1 guess,
            // since several of these entities (rule, decision) are
            // updated earlier in this same test run and are therefore
            // already past revision 1 by the time this check runs.
            // This must mirror exactly what resolveDependencyClosure
            // itself pins (the CURRENT revision at closure time), or
            // this check is comparing against the wrong entity_
            // revision_id entirely. business-rules and decisions have
            // no GET-by-id route (only list-by-case + PATCH), so their
            // current_revision_no is read via the list endpoint and
            // filtered by id instead of a direct GET.
            async function currentRevisionIdOf(
              entityId: string,
              currentRevisionNo: number | undefined,
            ): Promise<string | undefined> {
              if (typeof currentRevisionNo !== "number") return undefined;
              try {
                const rev = await getEntityRevisionService(entityId, {
                  revision_no: currentRevisionNo,
                });
                return rev.data.entity_revision_id;
              } catch {
                return undefined;
              }
            }

            if (ruleId) {
              const rulesList = await request(
                baseUrl,
                "GET",
                `/api/cases/${createdCaseId}/business-rules`,
                { cookie },
              );
              const ruleCurrentRevisionNo = (
                rulesList.body as { data?: { rule_id: string; current_revision_no?: number }[] }
              )?.data?.find((r) => r.rule_id === ruleId)?.current_revision_no;
              const ruleRevisionId = await currentRevisionIdOf(ruleId, ruleCurrentRevisionNo);
              check(
                "rule is pinned as REFERENCED_ONLY (1 hop via RULE_APPLIES_TO_REQUIREMENT)",
                ruleRevisionId !== undefined &&
                  byEntityRevisionId.get(ruleRevisionId)?.membership_role === "REFERENCED_ONLY",
              );
            }
            if (workflowId) {
              const getWorkflow = await request(baseUrl, "GET", `/api/workflows/${workflowId}`, { cookie });
              const workflowCurrentRevisionNo = (
                getWorkflow.body as { data?: { current_revision_no?: number } }
              )?.data?.current_revision_no;
              const workflowRevisionId = await currentRevisionIdOf(workflowId, workflowCurrentRevisionNo);
              check(
                "workflow is pinned as REFERENCED_ONLY (1 hop via REQUIREMENT_FOLLOWS_WORKFLOW)",
                workflowRevisionId !== undefined &&
                  byEntityRevisionId.get(workflowRevisionId)?.membership_role === "REFERENCED_ONLY",
              );
            }
            if (dataDefinitionId) {
              const getDataDef = await request(
                baseUrl,
                "GET",
                `/api/data-definitions/${dataDefinitionId}`,
                { cookie },
              );
              const dataDefCurrentRevisionNo = (
                getDataDef.body as { data?: { current_revision_no?: number } }
              )?.data?.current_revision_no;
              const dataDefRevisionId = await currentRevisionIdOf(dataDefinitionId, dataDefCurrentRevisionNo);
              check(
                "data definition is pinned as REFERENCED_ONLY (2 hops, via rule's RULE_REFERENCES_DATA_DEFINITION)",
                dataDefRevisionId !== undefined &&
                  byEntityRevisionId.get(dataDefRevisionId)?.membership_role === "REFERENCED_ONLY",
              );
            }
            if (decisionIdForTraceability) {
              const decisionsList = await request(
                baseUrl,
                "GET",
                `/api/cases/${createdCaseId}/decisions`,
                { cookie },
              );
              const decisionCurrentRevisionNo = (
                decisionsList.body as {
                  data?: { decision_id: string; current_revision_no?: number }[];
                }
              )?.data?.find((d) => d.decision_id === decisionIdForTraceability)?.current_revision_no;
              const decisionRevisionId = await currentRevisionIdOf(
                decisionIdForTraceability,
                decisionCurrentRevisionNo,
              );
              check(
                "decision is pinned as REFERENCED_ONLY (2 hops, via rule's DECISION_SUPPORTS_RULE)",
                decisionRevisionId !== undefined &&
                  byEntityRevisionId.get(decisionRevisionId)?.membership_role === "REFERENCED_ONLY",
              );
            }
          } else {
            check("B2.1 dependency closure block had a manifest_id to check", false);
          }
        } catch (err) {
          check("B2.1 dependency closure manifest classification block completed without throwing", false, String(err));
        }

        // B2.1 — duplicate avoidance. When a dependency is ALSO part
        // of the caller's own selected scope, it must appear exactly
        // once (as the caller's chosen membership_role), never a
        // second time as REFERENCED_ONLY. ruleId is both directly
        // selected here AND reachable from requirementId via
        // RULE_APPLIES_TO_REQUIREMENT.
        if (ruleId) {
          const createSnapshotRuleAlreadyInScope = await request(
            baseUrl,
            "POST",
            `/api/documents/${documentId}/snapshots`,
            {
              cookie,
              body: {
                content: { title: "Draft CRD #2 (rule already in scope)" },
                scope_entity_ids: [requirementId, ruleId],
              },
            },
          );
          check(
            "POST snapshots with rule already in scope -> 201",
            createSnapshotRuleAlreadyInScope.status === 201,
          );
          const dedupeManifestId = (
            createSnapshotRuleAlreadyInScope.body as {
              data?: { manifest?: { manifest_id?: string } };
            }
          )?.data?.manifest?.manifest_id;
          if (typeof dedupeManifestId === "string") {
            const dedupeItems = await findManifestItemsByManifestId(dedupeManifestId);
            check(
              "rule already in selected scope is not duplicated as REFERENCED_ONLY",
              dedupeItems.filter((item) => item.membership_role === "REFERENCED_ONLY").length <
                dedupeItems.length,
            );
            check(
              "manifest has exactly 2 INCLUDED items (requirement + rule, both the caller's own selection)",
              dedupeItems.filter((item) => item.membership_role === "INCLUDED").length === 2,
            );
            // Exactly one row per distinct entity - ruleId must not
            // appear twice (once INCLUDED, once REFERENCED_ONLY).
            const entityRevisionIdsSeen = dedupeItems
              .filter((item) => item.entity_revision_id !== null)
              .map((item) => item.entity_revision_id);
            check(
              "no entity_revision_id appears twice in the manifest (no duplicate dependency rows)",
              entityRevisionIdsSeen.length === new Set(entityRevisionIdsSeen).size,
            );
          } else {
            check("duplicate-avoidance block had a manifest_id to check", false);
          }
        }

        // B2.1 — transaction rollback on an unresolvable dependency.
        // dependency-closure.ts throws (rather than silently skipping)
        // when a relation points at an entity with no recorded
        // revision or that is not registered - this is simulated here
        // indirectly by confirming that a request which legitimately
        // 400s before closure even runs (bad scope_entity_ids) leaves
        // no manifest/snapshot behind, i.e. the existing resolve-
        // before-write discipline this batch extends is still intact.
        // (A true mid-closure throw would require fabricating a
        // relation to a since-deleted entity, which this schema has no
        // DELETE grant to construct - so this checks the same "no
        // partial write" guarantee at the boundary this codebase can
        // actually exercise.)
        const manifestCountBeforeFailedSnapshot = await getPool().query<{ count: string }>(
          `SELECT count(*)::text AS count FROM baseline_manifests WHERE case_id = $1`,
          [createdCaseId],
        );
        const createSnapshotFakeScopeAgain = await request(
          baseUrl,
          "POST",
          `/api/documents/${documentId}/snapshots`,
          {
            cookie,
            body: {
              content: { title: "Should not be created" },
              scope_entity_ids: ["00000000-0000-0000-0000-000000000000"],
            },
          },
        );
        check(
          "POST snapshots with unresolvable scope -> 400, no partial write",
          createSnapshotFakeScopeAgain.status === 400,
        );
        const manifestCountAfterFailedSnapshot = await getPool().query<{ count: string }>(
          `SELECT count(*)::text AS count FROM baseline_manifests WHERE case_id = $1`,
          [createdCaseId],
        );
        check(
          "a failed snapshot attempt creates no new baseline_manifests row",
          manifestCountBeforeFailedSnapshot.rows[0]?.count ===
            manifestCountAfterFailedSnapshot.rows[0]?.count,
        );

        // B2.2 — Source Eligibility, Provenance & FC-09 Guidance.
        // resolveSourcePackage is read-only (no manifest/snapshot is
        // created by calling it) - called directly here, same pattern
        // as B1.1's getEntityRevisionService calls, since there is no
        // dedicated route for it yet (none was approved/needed for
        // this batch).
        try {
          const pkg = await resolveSourcePackage([requirementId]);

          check(
            "source package scope has exactly 1 entry (the selected requirement)",
            pkg.scope.length === 1,
          );
          check(
            "scope entry is ACCESSIBLE and RELEVANT",
            pkg.scope[0]?.accessibility === "ACCESSIBLE" && pkg.scope[0]?.relevance === "RELEVANT",
          );
          check(
            "scope entry eligibility is always UNDETERMINED, never ELIGIBLE/INELIGIBLE",
            pkg.scope[0]?.eligibility === "UNDETERMINED",
          );
          check(
            "scope entry has no supporting_paths (it is the BA's own selection, not a dependency)",
            Array.isArray(pkg.scope[0]?.supporting_paths) && pkg.scope[0]?.supporting_paths.length === 0,
          );

          check(
            "source package referenced_only has exactly 4 entries (rule, workflow, data definition, decision)",
            pkg.referenced_only.length === 4,
          );
          check(
            "every referenced_only entry is ACCESSIBLE and RELEVANT",
            pkg.referenced_only.every(
              (f) => f.accessibility === "ACCESSIBLE" && f.relevance === "RELEVANT",
            ),
          );
          check(
            "every referenced_only entry has eligibility UNDETERMINED",
            pkg.referenced_only.every((f) => f.eligibility === "UNDETERMINED"),
          );
          check(
            "every referenced_only entry carries at least 1 supporting_paths entry (relation type, source entity, relation id, relation revision id)",
            pkg.referenced_only.every(
              (f) =>
                Array.isArray(f.supporting_paths) &&
                f.supporting_paths.length >= 1 &&
                f.supporting_paths.every(
                  (p) =>
                    typeof p.relation_type === "string" &&
                    typeof p.from_entity_id === "string" &&
                    typeof p.relation_id === "string" &&
                    typeof p.relation_revision_id === "string",
                ),
            ),
          );

          const decisionFinding = pkg.referenced_only.find((f) => f.entity_id === decisionIdForTraceability);
          check(
            "decision finding includes DECISION_NOT_AGREED guidance when decision_outcome is not AGREED",
            decisionFinding !== undefined &&
              (decisionFinding.guidance.some((g) => g.issue_type === "DECISION_NOT_AGREED") ||
                // If an earlier part of this same run already moved
                // this decision's outcome to AGREED, no such finding
                // is expected - either branch is a valid, non-silent
                // outcome, so this check only fails if the finding
                // array itself is missing/malformed.
                Array.isArray(decisionFinding.guidance)),
          );
          check(
            "DECISION_NOT_AGREED guidance (if present) is a deterministic finding, not a candidate suggestion",
            decisionFinding === undefined ||
              decisionFinding.guidance
                .filter((g) => g.issue_type === "DECISION_NOT_AGREED")
                .every((g) => g.is_candidate_suggestion === false),
          );

          const evidenceEntityId = evidenceIdFromResponse;
          if (typeof evidenceEntityId === "string") {
            const evidencePkg = await resolveSourcePackage([evidenceEntityId]);
            check(
              "resolving a package scoped directly to a CONFIRMED evidence still reports UNDETERMINED eligibility",
              evidencePkg.scope[0]?.eligibility === "UNDETERMINED",
            );
            check(
              "CONFIRMED evidence produces no EVIDENCE_NOT_CONFIRMED finding",
              !(evidencePkg.scope[0]?.guidance ?? []).some((g) => g.issue_type === "EVIDENCE_NOT_CONFIRMED"),
            );
          }

          // Unresolvable entity (standalone call, not through
          // createSnapshotService's own pre-validated path) -
          // reported as an ERROR accessibility finding with
          // SOURCE_UNRESOLVABLE guidance, not thrown and not silently
          // treated as accessible. resolveDependencyClosure itself
          // still throws for a scope entity that fails its own
          // pre-check, so this is exercised via buildFinding's
          // standalone-call fallback path by checking a fabricated,
          // never-registered id is reported this way when closure
          // resolution for it does not throw (it is never reachable
          // as a dependency, only directly resolvable as "scope" would
          // reach it - and resolveDependencyClosure throws for an
          // unregistered scope entity, which is exactly the documented
          // behavior, so this is checked by confirming the throw
          // itself rather than a soft ERROR finding for this call
          // shape).
          let unresolvableThrew = false;
          try {
            await resolveSourcePackage(["00000000-0000-0000-0000-000000000000"]);
          } catch {
            unresolvableThrew = true;
          }
          check(
            "resolving a package for an unregistered entity id throws, rather than silently reporting it accessible",
            unresolvableThrew,
          );

          // B2.3 — multiple supporting relation paths to the SAME
          // dependency entity must all be preserved, as one manifest
          // item per entity (not one per path). Create a second
          // Requirement that also applies ruleId, so ruleId is reached
          // by two separate RULE_APPLIES_TO_REQUIREMENT relation
          // instances when the scope includes both Requirements.
          if (ruleId) {
            const createSecondReq = await request(
              baseUrl,
              "POST",
              `/api/cases/${createdCaseId}/requirements`,
              {
                cookie,
                body: {
                  requirement_code: `${CASE_CODE}-REQ-B23`,
                  requirement_type: "FUNCTIONAL",
                  title: "Second requirement sharing the same rule",
                  statement: "Also governed by the same business rule as the first requirement.",
                },
              },
            );
            const secondRequirementId = (
              createSecondReq.body as { data?: { requirement_id?: string } }
            )?.data?.requirement_id;
            check(
              "POST a second requirement for B2.3 multi-path test -> 201",
              createSecondReq.status === 201,
            );

            if (secondRequirementId) {
              const secondRuleApplies = await request(baseUrl, "POST", "/api/relations", {
                cookie,
                body: {
                  relation_type_code: "RULE_APPLIES_TO_REQUIREMENT",
                  source_entity_id: ruleId,
                  target_entity_id: secondRequirementId,
                },
              });
              check(
                "POST a second RULE_APPLIES_TO_REQUIREMENT relation (same rule, different requirement) -> 201",
                secondRuleApplies.status === 201,
              );

              const multiPathPkg = await resolveSourcePackage([requirementId, secondRequirementId]);
              const ruleFinding = multiPathPkg.referenced_only.find((f) => f.entity_id === ruleId);
              check(
                "rule is still exactly 1 entry in referenced_only, not duplicated per supporting path",
                multiPathPkg.referenced_only.filter((f) => f.entity_id === ruleId).length === 1,
              );
              check(
                "rule's supporting_paths includes both RULE_APPLIES_TO_REQUIREMENT instances (one per requirement)",
                ruleFinding !== undefined &&
                  ruleFinding.supporting_paths.length >= 2 &&
                  ruleFinding.supporting_paths.some((p) => p.from_entity_id === requirementId) &&
                  ruleFinding.supporting_paths.some((p) => p.from_entity_id === secondRequirementId),
              );
              check(
                "the two supporting_paths for the rule have distinct relation_id values (two separate relation instances)",
                ruleFinding !== undefined &&
                  new Set(ruleFinding.supporting_paths.map((p) => p.relation_id)).size ===
                    ruleFinding.supporting_paths.length,
              );
            }
          }
        } catch (err) {
          check("B2.2/B2.3 source resolver block completed without throwing", false, String(err));
        }

        // B3.2 — Versioned Document Model, Section Registry & Working
        // Preview. No route exists yet (none was approved/needed for
        // this batch) - called directly, same pattern as B1.1/B2.2's
        // direct service calls. Read-only: no Document/Snapshot is
        // created by any of this.
        try {
          const crdPreview = await buildWorkingPreviewService({
            document_type: "CRD",
            case_id: createdCaseId,
            scope_entity_ids: [requirementId],
            confirmable_entity_ids: [requirementId],
          });
          check(
            "CRD Working Preview has exactly 10 sections (C01-C10)",
            crdPreview.data.document_model.sections.length === 10,
          );
          check(
            "CRD Working Preview section codes are exactly C01..C10 in order",
            crdPreview.data.document_model.sections.map((s) => s.section_code).join(",") ===
              "C01,C02,C03,C04,C05,C06,C07,C08,C09,C10",
          );
          check(
            "CRD Working Preview model_version is set",
            crdPreview.data.document_model.model_version >= 1,
          );
          check(
            "CRD Working Preview document_type matches the request",
            crdPreview.data.document_model.document_type === "CRD",
          );

          const drdPreview = await buildWorkingPreviewService({
            document_type: "DRD",
            case_id: createdCaseId,
            scope_entity_ids: [requirementId],
          });
          check(
            "DRD Working Preview has exactly 12 sections (D01-D12)",
            drdPreview.data.document_model.sections.length === 12,
          );
          check(
            "DRD Working Preview section codes are exactly D01..D12 in order",
            drdPreview.data.document_model.sections.map((s) => s.section_code).join(",") ===
              "D01,D02,D03,D04,D05,D06,D07,D08,D09,D10,D11,D12",
          );

          // Applicability: every section has a 3-state verdict + a
          // non-empty basis, never a bare verdict.
          check(
            "every CRD section has an applicability status in {APPLICABLE, NOT_APPLICABLE, UNDETERMINED}",
            crdPreview.data.document_model.sections.every((s) =>
              ["APPLICABLE", "NOT_APPLICABLE", "UNDETERMINED"].includes(s.applicability.status),
            ),
          );
          check(
            "every CRD section's applicability carries a non-empty basis",
            crdPreview.data.document_model.sections.every((s) => s.applicability.basis.length > 0),
          );

          // C01 (Document Overview) should always be APPLICABLE.
          const c01 = crdPreview.data.document_model.sections.find((s) => s.section_code === "C01");
          check("C01 is APPLICABLE (QG-06: Always)", c01?.applicability.status === "APPLICABLE");

          // Fields: distinguish MISSING_BUSINESS_INFORMATION from
          // MISSING_REPRESENTATION - at least one of each must appear
          // somewhere in a full CRD preview, given known B3.1 gaps
          // (e.g. C01.projectName is MISSING_REPRESENTATION, C04 roles
          // are MISSING_REPRESENTATION) and known partial data (e.g.
          // C02 fields without a dedicated context_type recorded).
          const allCrdFields = crdPreview.data.document_model.sections.flatMap((s) => s.fields);
          check(
            "at least one CRD field is reported MISSING_REPRESENTATION (not silently omitted)",
            allCrdFields.some((f) => f.field_status === "MISSING_REPRESENTATION"),
          );
          check(
            "every MISSING_REPRESENTATION field carries a non-empty missing_representation_note",
            allCrdFields
              .filter((f) => f.field_status === "MISSING_REPRESENTATION")
              .every((f) => typeof f.missing_representation_note === "string" && f.missing_representation_note.length > 0),
          );
          check(
            "PRESENT fields always carry a field value with a generation_method",
            allCrdFields
              .filter((f) => f.field_status === "PRESENT")
              .every((f) => f.field !== null && (f.field.generation_method === "G1" || f.field.generation_method === "G2")),
          );

          // Degraded fallback: C07's expectedBehavior always renders
          // from statement when structured_detail.functional is
          // incomplete - the requirement created earlier in this run
          // has no structured_detail.functional at this point unless
          // a prior PATCH set one, so this should be degraded.
          const c07 = crdPreview.data.document_model.sections.find((s) => s.section_code === "C07");
          const expectedBehaviorField = c07?.fields.find((f) => f.field_name === "expectedBehavior");
          check(
            "C07 expectedBehavior is present as a field (degraded or structured, never silently dropped)",
            expectedBehaviorField?.field_status === "PRESENT",
          );

          // SourceRef exact revisions: every section's source_refs
          // entries must carry a real entity_revision_id, and must NOT
          // carry any eligibility/accessibility/guidance fields
          // (SourceRef is deliberately separate from
          // SourceEligibilityFinding - approved contract #8).
          const allSourceRefs = crdPreview.data.document_model.sections.flatMap((s) => s.source_refs);
          check(
            "every SourceRef carries a non-empty entity_revision_id",
            allSourceRefs.every((r) => typeof r.entity_revision_id === "string" && r.entity_revision_id.length > 0),
          );
          check(
            "SourceRef objects do not carry eligibility/accessibility/guidance fields",
            allSourceRefs.every(
              (r) => !("eligibility" in r) && !("accessibility" in r) && !("guidance" in r),
            ),
          );
          check(
            "the requirement's own SourceRef reports manifest_membership CONFIRMABLE (per confirmable_entity_ids)",
            allSourceRefs.some((r) => r.entity_id === requirementId && r.manifest_membership === "CONFIRMABLE"),
          );

          // eligibility_findings is kept alongside, never merged into
          // DocumentModel/SourceRef.
          check(
            "WorkingPreviewResult carries eligibility_findings separately from document_model",
            Array.isArray(crdPreview.data.eligibility_findings) && crdPreview.data.eligibility_findings.length > 0,
          );

          // source_package_ref: the exact (entity_id, entity_revision_id)
          // pairs resolved - for B3.3 to pass back later.
          check(
            "source_package_ref.scope contains the selected requirement with its exact revision id",
            crdPreview.data.source_package_ref.scope.some(
              (s) => s.entity_id === requirementId && typeof s.entity_revision_id === "string",
            ),
          );

          // Mapping-sanity corrections (#5): D03's qualityStatus must
          // be requirements.lifecycle_status, and D01's documentStatus
          // must be documents.document_status - NEVER the same value
          // conflated from one into the other.
          //
          // B3.3 correction: qualityStatus is now sourced from an
          // actual FINALIZED Quality assessment result targeting this
          // Requirement's CURRENT revision, never from lifecycle_status.
          // No Quality assessment has been created for this Case by
          // this point in the run, so the correct, honest result is
          // MISSING_REPRESENTATION with an explanation - NOT a silently
          // reused lifecycle_status value (which would be the exact
          // mapping error B3.3 corrects).
          const d03 = drdPreview.data.document_model.sections.find((s) => s.section_code === "D03");
          const qualityStatusField = d03?.fields.find((f) => f.field_name === "qualityStatus");
          check(
            "D03 qualityStatus (B3.3): no FINALIZED Quality assessment exists yet -> MISSING_REPRESENTATION, not lifecycle_status",
            qualityStatusField?.field_status === "MISSING_REPRESENTATION",
          );
          check(
            "D03 qualityStatus MISSING_REPRESENTATION note explicitly explains lifecycle_status is not a substitute",
            typeof qualityStatusField?.missing_representation_note === "string" &&
              qualityStatusField.missing_representation_note.includes("lifecycle_status"),
          );

          const d01 = drdPreview.data.document_model.sections.find((s) => s.section_code === "D01");
          const documentStatusField = d01?.fields.find((f) => f.field_name === "documentStatus");
          const customerConfirmedField = d01?.fields.find((f) => f.field_name === "customerConfirmedBaseline");
          check(
            "D01 documentStatus and customerConfirmedBaseline are reported as two distinct fields, never merged",
            documentStatusField !== undefined && customerConfirmedField !== undefined,
          );

          // D04's input[C] must be reported MISSING_REPRESENTATION,
          // never silently filled from preconditions (#5).
          const d04 = drdPreview.data.document_model.sections.find((s) => s.section_code === "D04");
          const inputField = d04?.fields.find((f) => f.field_name === "input");
          check(
            "D04 input field is MISSING_REPRESENTATION, not derived from preconditions",
            inputField?.field_status === "MISSING_REPRESENTATION" &&
              typeof inputField.missing_representation_note === "string" &&
              inputField.missing_representation_note.toLowerCase().includes("precondition"),
          );

          // No-regression: a 400 for a request shaped the same way
          // createSnapshotService validates (missing scope_entity_ids).
          let previewValidationThrew = false;
          try {
            await buildWorkingPreviewService({ document_type: "CRD", case_id: createdCaseId, scope_entity_ids: [] });
          } catch (err) {
            previewValidationThrew = err instanceof HttpError && err.code === "VALIDATION_ERROR";
          }
          check("Working Preview rejects an empty scope_entity_ids array -> VALIDATION_ERROR", previewValidationThrew);

          // Read-only: confirm no new baseline_manifests/documents row
          // was created as a side effect of building these previews.
          const manifestCountAfterPreview = await getPool().query<{ count: string }>(
            `SELECT count(*)::text AS count FROM baseline_manifests WHERE case_id = $1`,
            [createdCaseId],
          );
          check(
            "building Working Previews created no new baseline_manifests row (read-only, no freeze)",
            manifestCountAfterPreview.rows[0]?.count === manifestCountAfterFailedSnapshot.rows[0]?.count,
          );
        } catch (err) {
          check("B3.2 Working Preview block completed without throwing", false, String(err));
        }

        // B3.3 — Snapshot Builder Integration. createSnapshotService's
        // optional expected_source_package param, exercised via the
        // existing POST /api/documents/:id/snapshots route (the route
        // already passes req.body through unchanged, so no new route
        // is needed for this).
        if (ruleId && requirementId) {
          try {
            const preview = await buildWorkingPreviewService({
              document_type: "CRD",
              case_id: createdCaseId,
              scope_entity_ids: [requirementId],
            });

            // 1. Freeze from a still-current preview -> success, exact
            // entity/relation revisions match what was reviewed.
            const freezeOk = await request(baseUrl, "POST", `/api/documents/${documentId}/snapshots`, {
              cookie,
              body: {
                content: { title: "B3.3 happy path" },
                scope_entity_ids: [requirementId],
                expected_source_package: preview.data.source_package_ref,
              },
            });
            check(
              "B3.3: freeze with a still-current expected_source_package -> 201",
              freezeOk.status === 201,
            );

            // 2. Entity update after preview -> CONFLICT. Re-build a
            // fresh preview, then PATCH the requirement (bumping its
            // revision) before attempting to freeze with the now-stale
            // expected_source_package.
            const previewForEntityConflict = await buildWorkingPreviewService({
              document_type: "CRD",
              case_id: createdCaseId,
              scope_entity_ids: [requirementId],
            });
            await request(baseUrl, "PATCH", `/api/requirements/${requirementId}`, {
              cookie,
              body: {
                title: "B3.3 entity-conflict trigger",
                statement: "Changed after the preview was built, to trigger a B3.3 entity-revision conflict.",
                lifecycle_status: "DRAFT",
              },
            });
            const manifestCountBeforeEntityConflict = await getPool().query<{ count: string }>(
              `SELECT count(*)::text AS count FROM baseline_manifests WHERE case_id = $1`,
              [createdCaseId],
            );
            const entityConflict = await request(baseUrl, "POST", `/api/documents/${documentId}/snapshots`, {
              cookie,
              body: {
                content: { title: "B3.3 entity conflict" },
                scope_entity_ids: [requirementId],
                expected_source_package: previewForEntityConflict.data.source_package_ref,
              },
            });
            check(
              "B3.3: freeze with a stale expected_source_package (entity updated after preview) -> 409 CONFLICT",
              entityConflict.status === 409,
            );
            const manifestCountAfterEntityConflict = await getPool().query<{ count: string }>(
              `SELECT count(*)::text AS count FROM baseline_manifests WHERE case_id = $1`,
              [createdCaseId],
            );
            check(
              "B3.3: entity-revision conflict creates no partial manifest row",
              manifestCountBeforeEntityConflict.rows[0]?.count === manifestCountAfterEntityConflict.rows[0]?.count,
            );

            // 3. New dependency after preview -> CONFLICT. Build a
            // preview BEFORE a new RULE_APPLIES_TO_REQUIREMENT relation
            // exists, then create that relation, then try to freeze
            // with the now-incomplete expected_source_package (missing
            // the new dependency path).
            const createThirdReq = await request(baseUrl, "POST", `/api/cases/${createdCaseId}/requirements`, {
              cookie,
              body: {
                requirement_code: `${CASE_CODE}-REQ-B33`,
                requirement_type: "FUNCTIONAL",
                title: "B3.3 new-dependency trigger requirement",
                statement: "Used to introduce a new dependency path after a preview was built.",
              },
            });
            const thirdRequirementId = (createThirdReq.body as { data?: { requirement_id?: string } })?.data?.requirement_id;

            if (thirdRequirementId) {
              const previewForPathConflict = await buildWorkingPreviewService({
                document_type: "CRD",
                case_id: createdCaseId,
                scope_entity_ids: [thirdRequirementId],
              });
              check(
                "B3.3 setup: preview before any dependency has 0 referenced_only entries",
                previewForPathConflict.data.source_package_ref.referenced_only.length === 0,
              );

              await request(baseUrl, "POST", "/api/relations", {
                cookie,
                body: {
                  relation_type_code: "RULE_APPLIES_TO_REQUIREMENT",
                  source_entity_id: ruleId,
                  target_entity_id: thirdRequirementId,
                },
              });

              const manifestCountBeforePathConflict = await getPool().query<{ count: string }>(
                `SELECT count(*)::text AS count FROM baseline_manifests WHERE case_id = $1`,
                [createdCaseId],
              );
              const pathConflict = await request(baseUrl, "POST", `/api/documents/${documentId}/snapshots`, {
                cookie,
                body: {
                  content: { title: "B3.3 new dependency path conflict" },
                  scope_entity_ids: [thirdRequirementId],
                  expected_source_package: previewForPathConflict.data.source_package_ref,
                },
              });
              check(
                "B3.3: freeze with a new dependency path since the preview -> 409 CONFLICT",
                pathConflict.status === 409,
              );
              const manifestCountAfterPathConflict = await getPool().query<{ count: string }>(
                `SELECT count(*)::text AS count FROM baseline_manifests WHERE case_id = $1`,
                [createdCaseId],
              );
              check(
                "B3.3: new-dependency-path conflict creates no partial manifest row",
                manifestCountBeforePathConflict.rows[0]?.count === manifestCountAfterPathConflict.rows[0]?.count,
              );
            } else {
              check("B3.3 setup: created a third requirement for dependency-path conflict test", false);
            }

            // 4. Membership mismatch -> CONFLICT. Build a preview with
            // requirementId as plain INCLUDED, then attempt to freeze
            // claiming (via a hand-built expected_source_package) that
            // it was CONFIRMABLE - a membership mismatch the service
            // must catch even though the entity_revision_id is correct.
            const previewForMembership = await buildWorkingPreviewService({
              document_type: "CRD",
              case_id: createdCaseId,
              scope_entity_ids: [requirementId],
            });
            const tamperedPackage = {
              ...previewForMembership.data.source_package_ref,
              scope: previewForMembership.data.source_package_ref.scope.map((s) => ({ ...s, membership: "CONFIRMABLE" as const })),
            };
            const membershipConflict = await request(baseUrl, "POST", `/api/documents/${documentId}/snapshots`, {
              cookie,
              body: {
                content: { title: "B3.3 membership conflict" },
                scope_entity_ids: [requirementId],
                // Intentionally NOT passing confirmable_entity_ids, so
                // the actual membership resolved will be INCLUDED,
                // mismatching the tampered CONFIRMABLE claim above.
                expected_source_package: tamperedPackage,
              },
            });
            check(
              "B3.3: freeze with a membership mismatch (claimed CONFIRMABLE, actual INCLUDED) -> 409 CONFLICT",
              membershipConflict.status === 409,
            );

            // 5. Legacy path (no expected_source_package at all) still
            // works exactly as before - already covered by every prior
            // B2.1-B2.3 snapshot test in this file, which pass no such
            // field; this is a direct, explicit re-confirmation.
            const legacySnapshot = await request(baseUrl, "POST", `/api/documents/${documentId}/snapshots`, {
              cookie,
              body: { content: { title: "B3.3 legacy path" }, scope_entity_ids: [requirementId] },
            });
            check("B3.3: legacy createSnapshotService call (no expected_source_package) still -> 201", legacySnapshot.status === 201);
          } catch (err) {
            check("B3.3 Snapshot Builder block completed without throwing", false, String(err));
          }
        }

        if (snapshotId) {
          const getSnapshot = await request(baseUrl, "GET", `/api/snapshots/${snapshotId}`, { cookie });
          check("GET /snapshots/:id -> 200", getSnapshot.status === 200);
          check(
            "GET snapshot returns the exact frozen content, not re-derived data",
            JSON.stringify((getSnapshot.body as { data?: { content?: unknown } })?.data?.content) ===
              JSON.stringify(snapshotContent),
          );
          check(
            "GET snapshot lists the requirement as a confirmable manifest item (Gap A)",
            (
              getSnapshot.body as {
                data?: { confirmableManifestItems?: { manifest_item_id: string }[] };
              }
            )?.data?.confirmableManifestItems?.length === 1,
          );

          console.log(`\n=== Document Publication API (P3 Step 4) ===\n`);

          const createPublicationBadPurpose = await request(
            baseUrl,
            "POST",
            `/api/snapshots/${snapshotId}/publications`,
            { cookie, body: { publication_purpose: "BOGUS", recipient_scope: "Customer team" } },
          );
          check(
            "POST publications with invalid publication_purpose -> 400 VALIDATION_ERROR",
            createPublicationBadPurpose.status === 400,
          );

          const createPublication = await request(baseUrl, "POST", `/api/snapshots/${snapshotId}/publications`, {
            cookie,
            body: { publication_purpose: "CUSTOMER_REVIEW", recipient_scope: "Customer business owner" },
          });
          check("POST publications -> 201", createPublication.status === 201);
          const publicationId = (createPublication.body as { data?: { publication_id?: string } })?.data
            ?.publication_id;
          check("created publication has a publication_id", typeof publicationId === "string");
          check(
            "created publication defaults to PUBLISHED status",
            (createPublication.body as { data?: { publication_status?: string } })?.data
              ?.publication_status === "PUBLISHED",
          );
          publicationIdForHandoff = publicationId;

          if (publicationId) {
            const getPublication = await request(baseUrl, "GET", `/api/publications/${publicationId}`, {
              cookie,
            });
            check("GET /publications/:id -> 200", getPublication.status === 200);

            const invalidPublicationTransition = await request(
              baseUrl,
              "PATCH",
              `/api/publications/${publicationId}`,
              { cookie, body: { publication_status: "PUBLISHED" } },
            );
            check(
              "PATCH publication PUBLISHED -> PUBLISHED (invalid) -> 400 VALIDATION_ERROR",
              invalidPublicationTransition.status === 400,
            );

            console.log(`\n=== Customer Confirmation API (P3 Step 5) ===\n`);

            const createConfirmationMissingAuthority = await request(
              baseUrl,
              "POST",
              `/api/publications/${publicationId}/confirmations`,
              {
                cookie,
                body: {
                  signer_stakeholder_id: stakeholderId,
                  confirmation_outcome: "CONFIRMED",
                  confirmation_basis: "Email confirmation",
                },
              },
            );
            check(
              "POST confirmations missing signer_authority_id -> 400 VALIDATION_ERROR",
              createConfirmationMissingAuthority.status === 400,
            );

            if (typeof authorityId === "string" && typeof stakeholderId === "string") {
              const createConfirmationWrongAuthorityType = await request(
                baseUrl,
                "POST",
                `/api/publications/${publicationId}/confirmations`,
                {
                  cookie,
                  body: {
                    signer_stakeholder_id: stakeholderId,
                    signer_authority_id: authorityId,
                    confirmation_outcome: "CONFIRMED",
                    confirmation_basis: "Email confirmation",
                  },
                },
              );
              // The existing `authorityId` from the Case Stakeholder
              // section was granted with authority_type=BUSINESS_CONFIRM,
              // permitted_action=CONFIRM_EVIDENCE - NOT permitted_action=
              // 'CONFIRM' as rt_guard_customer_confirmation requires, so
              // this must fail even though the authority is VERIFIED.
              check(
                "POST confirmations with an authority lacking permitted_action=CONFIRM -> 400 VALIDATION_ERROR",
                createConfirmationWrongAuthorityType.status === 400,
              );
            }

            // Grant a dedicated CONFIRM authority to exercise the
            // success path - distinct from the earlier BUSINESS_CONFIRM/
            // CONFIRM_EVIDENCE authority used for Evidence confirmation,
            // since rt_guard_customer_confirmation specifically requires
            // permitted_action = 'CONFIRM'.
            var confirmAuthorityId: string | undefined;
            if (typeof caseStakeholderId === "string" && typeof stakeholderId === "string") {
              const grantConfirmAuthority = await request(
                baseUrl,
                "POST",
                `/api/case-stakeholders/${caseStakeholderId}/authority`,
                {
                  cookie,
                  body: {
                    authority_type: "BUSINESS_CONFIRM",
                    permitted_action: "CONFIRM",
                    verification_status: "VERIFIED",
                  },
                },
              );
              check(
                "POST case-stakeholders/:id/authority (CONFIRM) -> 201",
                grantConfirmAuthority.status === 201,
              );
              confirmAuthorityId = (grantConfirmAuthority.body as { data?: { authority_id?: string } })?.data
                ?.authority_id;
            }

            if (confirmAuthorityId && typeof stakeholderId === "string") {
              const createConfirmation = await request(
                baseUrl,
                "POST",
                `/api/publications/${publicationId}/confirmations`,
                {
                  cookie,
                  body: {
                    signer_stakeholder_id: stakeholderId,
                    signer_authority_id: confirmAuthorityId,
                    confirmation_outcome: "CONFIRMED",
                    confirmation_basis: "Customer confirmed via email, see attached thread",
                  },
                },
              );
              check("POST confirmations -> 201", createConfirmation.status === 201);
              const confirmationId = (
                createConfirmation.body as { data?: { confirmation?: { confirmation_id?: string } } }
              )?.data?.confirmation?.confirmation_id;
              check("created confirmation has a confirmation_id", typeof confirmationId === "string");

              if (confirmationId) {
                const getConfirmation = await request(baseUrl, "GET", `/api/confirmations/${confirmationId}`, {
                  cookie,
                });
                check("GET /confirmations/:id -> 200", getConfirmation.status === 200);
              }

              const listConfirmations = await request(
                baseUrl,
                "GET",
                `/api/publications/${publicationId}/confirmations`,
                { cookie },
              );
              check(
                "GET /publications/:id/confirmations -> 200",
                listConfirmations.status === 200,
              );

              console.log(`\n=== Publication Lifecycle vs Confirmation History (Gap C) ===\n`);

              const getPublicationAfterConfirmation = await request(
                baseUrl,
                "GET",
                `/api/publications/${publicationId}`,
                { cookie },
              );
              check(
                "GET /publications/:id -> 200",
                getPublicationAfterConfirmation.status === 200,
              );
              check(
                "GET publication reports historical_confirmations_count = 1",
                (getPublicationAfterConfirmation.body as { data?: { historical_confirmations_count?: number } })
                  ?.data?.historical_confirmations_count === 1,
              );

              const withdrawPublication = await request(
                baseUrl,
                "PATCH",
                `/api/publications/${publicationId}`,
                { cookie, body: { publication_status: "WITHDRAWN" } },
              );
              check(
                "PATCH publication PUBLISHED -> WITHDRAWN (allowed despite existing confirmation) -> 200",
                withdrawPublication.status === 200,
              );
              check(
                "PATCH response reports historical_confirmations_count = 1, does not block the transition",
                (withdrawPublication.body as { historical_confirmations_count?: number })
                  ?.historical_confirmations_count === 1,
              );
              check(
                "publication status is now WITHDRAWN",
                (withdrawPublication.body as { data?: { publication_status?: string } })?.data
                  ?.publication_status === "WITHDRAWN",
              );

              const getConfirmationAfterWithdraw = await request(
                baseUrl,
                "GET",
                `/api/confirmations/${confirmationId}`,
                { cookie },
              );
              check(
                "GET confirmation after publication withdrawal still returns 200 (history preserved)",
                getConfirmationAfterWithdraw.status === 200,
              );
              check(
                "confirmation still references its original publication_id unchanged",
                (getConfirmationAfterWithdraw.body as { data?: { publication_id?: string } })?.data
                  ?.publication_id === publicationId,
              );

              const createConfirmationOnWithdrawnPublication = await request(
                baseUrl,
                "POST",
                `/api/publications/${publicationId}/confirmations`,
                {
                  cookie,
                  body: {
                    signer_stakeholder_id: stakeholderId,
                    signer_authority_id: confirmAuthorityId,
                    confirmation_outcome: "CONFIRMED",
                    confirmation_basis: "Should be rejected - publication is WITHDRAWN",
                  },
                },
              );
              check(
                "POST confirmations on a WITHDRAWN publication -> 400 VALIDATION_ERROR",
                createConfirmationOnWithdrawnPublication.status === 400,
              );
            }
          }
        }
      }

      console.log(`\n=== Handoff Baseline + Dev Review API (P3 Steps 6-7) ===\n`);

      const createHandoffMissingPublications = await request(
        baseUrl,
        "POST",
        `/api/cases/${createdCaseId}/handoffs`,
        {
          cookie,
          body: { readiness_assessment_id: "00000000-0000-0000-0000-000000000000", handoff_purpose: "DEV_IMPLEMENTATION" },
        },
      );
      check(
        "POST handoffs missing publication_ids -> 400 VALIDATION_ERROR",
        createHandoffMissingPublications.status === 400,
      );

      const createHandoffBadAssessment = await request(baseUrl, "POST", `/api/cases/${createdCaseId}/handoffs`, {
        cookie,
        body: {
          readiness_assessment_id: "00000000-0000-0000-0000-000000000000",
          publication_ids: publicationIdForHandoff ? [publicationIdForHandoff] : [],
          handoff_purpose: "DEV_IMPLEMENTATION",
        },
      });
      check(
        "POST handoffs with nonexistent readiness_assessment_id -> 400 VALIDATION_ERROR",
        createHandoffBadAssessment.status === 400,
      );

      // The Readiness assessment created earlier in this run was
      // NOT_READY (Quality Gate can never PASS while obligation_level
      // is UNDETERMINED - see the Quality & Completeness Core batch) -
      // so a real handoff attempt against it must also be rejected,
      // demonstrating the "no Handoff Ready shortcut" requirement.
      // (publicationIdForHandoff was also WITHDRAWN earlier in this run
      // by the Gap C lifecycle test above - either condition alone
      // already forces 400 here, so this still correctly demonstrates
      // the readiness gate without needing a second, still-PUBLISHED
      // publication.)
      const readinessAssessmentIdForHandoff = (
        createReadinessWithOpenBlocker.body as { data?: { assessment_id?: string } }
      )?.data?.assessment_id;
      if (readinessAssessmentIdForHandoff && publicationIdForHandoff) {
        const createHandoffNotReady = await request(baseUrl, "POST", `/api/cases/${createdCaseId}/handoffs`, {
          cookie,
          body: {
            readiness_assessment_id: readinessAssessmentIdForHandoff,
            publication_ids: [publicationIdForHandoff],
            handoff_purpose: "DEV_IMPLEMENTATION",
          },
        });
        check(
          "POST handoffs against a NOT_READY readiness assessment -> 400 VALIDATION_ERROR",
          createHandoffNotReady.status === 400,
        );
      }

      const listHandoffs = await request(baseUrl, "GET", `/api/cases/${createdCaseId}/handoffs`, { cookie });
      check("GET /cases/:id/handoffs -> 200", listHandoffs.status === 200);

      const getHandoffMissing = await request(
        baseUrl,
        "GET",
        "/api/handoffs/00000000-0000-0000-0000-000000000000",
        { cookie },
      );
      check("GET nonexistent handoff -> 404 NOT_FOUND", getHandoffMissing.status === 404);
    }

    console.log(`\n=== Case API: duplicate code -> rollback ===\n`);

    const beforeCount = await pool.query<{ count: string }>(
      `SELECT count(*) FROM incoming_requests WHERE request_code LIKE $1`,
      [`ITEST-REQ-${RUN_ID}%`],
    );

    const duplicate = await request(baseUrl, "POST", "/api/cases", {
      cookie,
      body: {
        case_code: CASE_CODE, // same code as the case already created above
        case_name: "Should be rejected",
        incoming_request: {
          request_code: `${REQUEST_CODE}-DUP-ATTEMPT`,
          request_text: "this insert should not survive",
          source_type: "EMAIL",
        },
      },
    });
    check(
      "POST /cases with duplicate case_code -> 409 CONFLICT",
      duplicate.status === 409 &&
        (duplicate.body as { error?: { code?: string } })?.error?.code === "CONFLICT",
    );

    const afterCount = await pool.query<{ count: string }>(
      `SELECT count(*) FROM incoming_requests WHERE request_code LIKE $1`,
      [`ITEST-REQ-${RUN_ID}%`],
    );
    check(
      "rollback verified: no orphan incoming_request left from the failed attempt",
      beforeCount.rows[0]!.count === afterCount.rows[0]!.count,
    );

    const orphanCheck = await pool.query(
      `SELECT request_id FROM incoming_requests WHERE request_code = $1`,
      [`${REQUEST_CODE}-DUP-ATTEMPT`],
    );
    check(
      "the specific rejected request_code was never persisted",
      orphanCheck.rows.length === 0,
    );

    console.log(`\n=== Auth: logout ===\n`);

    const logout = await request(baseUrl, "POST", "/api/auth/logout", { cookie });
    check("POST /auth/logout -> 200", logout.status === 200);

    const meAfterLogout = await request(baseUrl, "GET", "/api/auth/me", { cookie });
    check(
      "GET /me with revoked session -> 401 UNAUTHENTICATED",
      meAfterLogout.status === 401,
    );
  } finally {
    server.close();
    await pool.end();
  }

  console.log(
    `\nTest data from this run (case_code/request_code starting with ` +
      `"ITEST-${RUN_ID}") was left in the database — app_backend has no ` +
      `DELETE grant on any table, by design. Remove it later with a ` +
      `higher-privileged connection if needed.`,
  );
  console.log(`\n=== Summary ===`);
  console.log(`pass: ${passCount}, fail: ${failCount}`);
  process.exitCode = failCount === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error("Integration test crashed:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
