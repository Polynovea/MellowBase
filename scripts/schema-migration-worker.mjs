#!/usr/bin/env node
/**
 * Schema migration worker (self-hosted upgrade, phase 3).
 *
 * Applies the schema changes the CMS queues in schema_migration_ledger: one stage at a time, as
 * polynovea_owner, on its own small connection pool. The CMS server never holds owner rights; it only
 * writes the ledger row. Run it next to the delivery worker:
 *
 *   npm run worker:schema            # poll every 1.5 s
 *   npm run worker:schema -- --once  # run what is waiting, then exit
 *
 * Connection: POLYNOVEA_MIGRATION_DATABASE_URL (else DATABASE_URL), the polynovea_owner login. It
 * MUST be a direct connection to PostgreSQL (or a session-mode pooler). A transaction-mode pooler
 * (PgBouncer in transaction mode, Supabase's port 6543) breaks it: the worker holds a session
 * advisory lock (class 0x504D5233, "PMR3") for each run and builds indexes CONCURRENTLY outside a
 * transaction, and both need every statement of a run on the same server connection.
 *
 * Other settings: POLYNOVEA_MIGRATION_STATEMENT_TIMEOUT_MS (default 30 minutes; lock waits are always
 * 3 seconds), POLYNOVEA_MIGRATION_ALLOW_ROLE (another login that owns the content schema, e.g.
 * `postgres` on an existing Supabase install), POLYNOVEA_RELEASE_ID (default: the package version;
 * renames and type changes drop their old column once a worker of a newer release runs, or after
 * 7 days), SCHEMA_WORKER_POLL_MS.
 *
 * Logs carry event names, ids and error codes only: never SQL text, identifiers or values.
 */
import { register } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import { randomUUID } from "node:crypto";

// Resolves the "@/" imports of the TypeScript modules (Node strips their types itself).
register("./phase12_75-node-loader.mjs", import.meta.url);

if (existsSync(".env.local")) {
  for (const raw of readFileSync(".env.local", "utf8").split("\n")) {
    const match = raw.trim().match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, "");
  }
}

const { createOwnerPool, assertOwnerSession } = await import("../lib/schema/runner/ownerPool.ts");
const { runNextStage, runDueContracts } = await import("../lib/schema/runner/runner.ts");
const { productionEngine } = await import("../lib/schema/runner/engineAdapter.ts");
const { errorCode } = await import("../lib/schema/runner/errors.ts");

const once = process.argv.includes("--once");
const pollMs = Math.max(250, Number(process.env.SCHEMA_WORKER_POLL_MS || 1500));
const workerId = process.env.SCHEMA_WORKER_ID || `${os.hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
const releaseId = process.env.POLYNOVEA_RELEASE_ID?.trim() || JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
const log = (event, fields = {}) => console.log(JSON.stringify({ at: new Date().toISOString(), worker: "schema", event, ...fields }));

let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { stopping = true; });

const engine = productionEngine();
const pool = createOwnerPool();
const client = await pool.connect();
try {
  await assertOwnerSession(client);
  log("started", { workerId, releaseId, once });
  while (!stopping) {
    let worked = false;
    try {
      const outcome = await runNextStage(client, { engine, workerId, releaseId, log });
      if (outcome) worked = true;
      else await runDueContracts(client, { releaseId, log });
    } catch (error) {
      log("loop_error", { code: errorCode(error) });
    }
    if (once && !worked) break;
    if (!worked) await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
} finally {
  client.release();
  await pool.end();
  log("stopped", { workerId });
}
