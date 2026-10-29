// Feasibility check for Phase 2, run against the live database after
// migration 003 has been applied.
//
// Split into two clearly separate kinds of check:
//   - "expected to succeed" assertions (grants, schema usage, role
//     attributes, membership) — section A
//   - "expected to be denied" assertions (access outside the granted
//     6 tables) — section B
// kept apart so a failure in B (an access path that should be
// blocked but isn't) is never read as the same kind of problem as a
// failure in A (a grant that's missing or wrong). Each section prints
// its own verdict line.
//
// Does not INSERT/UPDATE business data — only reads catalog metadata
// and attempts one denied SELECT. Run manually, not in CI.
//
// Usage:
//   npm run check-db-access

import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";

// dotenv's default `dotenv/config` import only reads `.env`. This
// project's convention (and .gitignore) is `.env.local` — load that
// explicitly so this script actually sees PGHOST/PGPASSWORD/etc.
// without requiring a second, differently-named env file.
// fileURLToPath (not `.pathname`) is required for a correct path on
// Windows, where a bare `.pathname` keeps a leading slash in front of
// the drive letter (e.g. "/D:/...") and fails to resolve.
loadEnv({ path: fileURLToPath(new URL("../.env.local", import.meta.url)) });

const { getPool } = await import("../src/db/pool.js");
const pool = getPool();

const EXPECTED_GRANTS: Record<string, string[]> = {
  cases: ["SELECT", "INSERT", "UPDATE"],
  incoming_requests: ["SELECT", "INSERT"],
  case_request_associations: ["SELECT", "INSERT"],
  requirements: ["SELECT"],
  audit_events: ["INSERT"],
  app_users: ["SELECT"],
};

async function checkExpectedToSucceed(client: import("pg").PoolClient): Promise<boolean> {
  console.log("=== Section A: checks expected to SUCCEED ===\n");
  let allOk = true;

  const schemaUsage = await client.query<{ has_schema_privilege: boolean }>(
    `SELECT has_schema_privilege('app_backend', 'public', 'USAGE') AS has_schema_privilege`,
  );
  const hasUsage = schemaUsage.rows[0]?.has_schema_privilege === true;
  console.log(`${hasUsage ? "OK  " : "FAIL"} USAGE ON SCHEMA public`);
  if (!hasUsage) allOk = false;

  const roleAttrs = await client.query<{
    rolsuper: boolean;
    rolcreatedb: boolean;
    rolcreaterole: boolean;
    rolbypassrls: boolean;
  }>(
    `SELECT rolsuper, rolcreatedb, rolcreaterole, rolbypassrls
     FROM pg_roles WHERE rolname = 'app_backend'`,
  );
  const attrs = roleAttrs.rows[0];
  const attrsOk =
    !!attrs &&
    !attrs.rolsuper &&
    !attrs.rolcreatedb &&
    !attrs.rolcreaterole &&
    !attrs.rolbypassrls;
  console.log(
    `${attrsOk ? "OK  " : "FAIL"} role attributes (no superuser/createdb/createrole/bypassrls): ${JSON.stringify(attrs)}`,
  );
  if (!attrsOk) allOk = false;

  const membership = await client.query<{ rolname: string }>(
    `SELECT r.rolname
     FROM pg_auth_members m
     JOIN pg_roles r ON r.oid = m.roleid
     JOIN pg_roles m2 ON m2.oid = m.member
     WHERE m2.rolname = 'app_backend'`,
  );
  const noElevatedMembership = membership.rows.length === 0;
  console.log(
    `${noElevatedMembership ? "OK  " : "FAIL"} no role membership that could widen effective privileges (found: ${membership.rows.map((r) => r.rolname).join(", ") || "none"})`,
  );
  if (!noElevatedMembership) allOk = false;

  const { rows: grantRows } = await client.query<{
    table_name: string;
    privilege_type: string;
  }>(
    `SELECT table_name, privilege_type
     FROM information_schema.role_table_grants
     WHERE grantee = 'app_backend'
     ORDER BY table_name, privilege_type`,
  );

  const actual: Record<string, string[]> = {};
  for (const row of grantRows) {
    (actual[row.table_name] ??= []).push(row.privilege_type);
  }

  for (const [table, expected] of Object.entries(EXPECTED_GRANTS)) {
    const got = (actual[table] ?? []).sort();
    const want = [...expected].sort();
    const matches = JSON.stringify(got) === JSON.stringify(want);
    if (!matches) allOk = false;
    console.log(
      `${matches ? "OK  " : "FAIL"} ${table}: expected [${want.join(", ")}], got [${got.join(", ") || "none"}]`,
    );
  }

  const unexpectedTables = Object.keys(actual).filter(
    (t) => !(t in EXPECTED_GRANTS),
  );
  if (unexpectedTables.length > 0) {
    allOk = false;
    console.log(`FAIL unexpected grants found on: ${unexpectedTables.join(", ")}`);
  }

  const anyDelete = grantRows.some((r) => r.privilege_type === "DELETE");
  if (anyDelete) {
    allOk = false;
    console.log("FAIL DELETE privilege found somewhere - should never be granted");
  }

  console.log(`\nSection A verdict: ${allOk ? "PASS" : "FAIL"}\n`);
  return allOk;
}

async function checkExpectedToBeDenied(client: import("pg").PoolClient): Promise<boolean> {
  console.log("=== Section B: checks expected to be DENIED ===\n");
  let allOk = true;

  console.log("Trying SELECT on public.stakeholders (outside the 6 granted tables)...");
  try {
    await client.query("SELECT 1 FROM public.stakeholders LIMIT 1");
    console.log("FAIL stakeholders was readable - grant scope is too wide");
    allOk = false;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("permission denied")) {
      console.log("OK   stakeholders correctly denied");
    } else {
      console.log(`FAIL unexpected error (not a permission denial): ${message}`);
      allOk = false;
    }
  }

  console.log("\nTrying DELETE on public.cases (never granted on any table)...");
  try {
    await client.query("DELETE FROM public.cases WHERE false");
    console.log("FAIL DELETE on cases did not error - DELETE must never be reachable");
    allOk = false;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("permission denied")) {
      console.log("OK   DELETE on cases correctly denied");
    } else {
      console.log(`FAIL unexpected error (not a permission denial): ${message}`);
      allOk = false;
    }
  }

  console.log(`\nSection B verdict: ${allOk ? "PASS" : "FAIL"}\n`);
  return allOk;
}

async function main(): Promise<void> {
  const client = await pool.connect();
  try {
    const aOk = await checkExpectedToSucceed(client);
    const bOk = await checkExpectedToBeDenied(client);

    console.log("=== Overall ===");
    console.log(`Section A (expected success): ${aOk ? "PASS" : "FAIL"}`);
    console.log(`Section B (expected denial):  ${bOk ? "PASS" : "FAIL"}`);
    console.log(`\n${aOk && bOk ? "ALL CHECKS PASSED" : "SOME CHECKS FAILED"}`);
    process.exitCode = aOk && bOk ? 0 : 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error("check-db-access failed:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
