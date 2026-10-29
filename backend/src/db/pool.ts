// Single pg.Pool for the entire backend, connected as app_backend.
//
// This is the only place that reads database credentials. Every
// module calls getPool() or withTransaction from here — none of
// them construct their own client or connection string.

import { readFileSync } from "node:fs";
import { Pool, type PoolClient } from "pg";

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

let poolInstance: Pool | undefined;

/**
 * Lazily constructs the Pool on first use rather than at module load
 * time. This matters beyond style: service/repository modules import
 * this file at the top level, and plenty of code that imports those
 * modules (e.g. validation-only unit tests) never actually executes
 * a query. A pool built eagerly at import time would require
 * PGHOST/PGPASSWORD/etc. to be set just to run `npm test`, even for
 * tests that exercise nothing but input validation and never open a
 * real connection.
 *
 * Exported directly (not wrapped in a Proxy) deliberately: a Proxy
 * forwarding method calls to the real Pool instance would invoke
 * them with the Proxy itself as `this`, which risks breaking on any
 * internal use of private class fields (`#foo`) inside pg's Pool
 * implementation. Every call site uses getPool().query(...) /
 * getPool().connect() instead, so `this` is always the real Pool.
 */
export function getPool(): Pool {
  if (!poolInstance) {
    // Both Supabase connection paths — direct (db.<project>.supabase.co)
    // and pooler (*.pooler.supabase.com) — present a certificate chain
    // signed by Supabase's own CA, not one in Node's default trust
    // store. Plain `rejectUnauthorized: true` therefore fails with
    // "self-signed certificate in certificate chain" on either path
    // unless that CA is trusted explicitly via PGSSLROOTCERT, pointing
    // at the bundle downloaded from Project Settings -> Database ->
    // SSL Configuration. This is required in practice for both hosts;
    // it is not direct-connection-only.
    const sslRootCertPath = process.env.PGSSLROOTCERT;

    poolInstance = new Pool({
      host: requiredEnv("PGHOST"),
      port: Number(process.env.PGPORT ?? 5432),
      database: requiredEnv("PGDATABASE"),
      user: requiredEnv("PGUSER"), // expected to be "app_backend.<project_ref>"
      password: requiredEnv("PGPASSWORD"),
      ssl: {
        rejectUnauthorized: true,
        ca: sslRootCertPath ? readFileSync(sslRootCertPath, "utf8") : undefined,
      },
      max: 10,
    });
  }
  return poolInstance;
}

/**
 * Runs `fn` inside a single BEGIN/COMMIT, on one checked-out
 * connection. Every statement `fn` issues via the passed client runs
 * on that same connection, so transactional guarantees hold exactly
 * as they would inside a PL/pgSQL function — without needing one.
 * Any thrown error triggers ROLLBACK before the error propagates.
 */
export async function withTransaction<T>(
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
