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
 *   npm run worker:schema -- --model <uuid>  # only that model's stages (also --model=<uuid>);
 *                                    # contracts then run only with --contracts
 *                                    # after each pass it re-syncs and re-verifies moved models whose
 *                                    # table changed shape (lib/content/contentMove.ts, resyncChangedModels)
 *   npm run worker:schema -- --rollback-task=<uuid>
 *                                    # undo a failed expand (trigger, guard index, new column), then exit
 *
 * Start it with the project's module loader, like the certification scripts (Node strips the
 * TypeScript types itself; the loader resolves the "@/lib/..." imports):
 *
 *   node --loader ./scripts/phase12_75-node-loader.mjs scripts/schema-migration-worker.mjs
 *
 * Connection: POLYNOVEA_MIGRATION_DATABASE_URL (else DATABASE_URL), the polynovea_owner login. It
 * MUST be a direct connection to PostgreSQL (or a session-mode pooler). A transaction-mode pooler
 * (PgBouncer in transaction mode, Supabase's port 6543) breaks it: the worker holds a session
 * advisory lock (class 0x504D5233, "PMR3") for each run and builds indexes CONCURRENTLY outside a
 * transaction, and both need every statement of a run on the same server connection.
 *
 * Other settings: POLYNOVEA_MIGRATION_STATEMENT_TIMEOUT_MS (default 30 minutes; lock waits are always
 * 3 seconds, except CREATE/DROP INDEX CONCURRENTLY: POLYNOVEA_MIGRATION_CONCURRENT_LOCK_TIMEOUT_MS,
 * default 10 minutes, as those wait for every older transaction but never block reads or writes),
 * POLYNOVEA_MIGRATION_ALLOW_ROLE (another login that owns the content schema, e.g.
 * `postgres` on an existing Supabase install), POLYNOVEA_RELEASE_ID (default: the package version;
 * renames and type changes drop their old column once a worker of a newer release runs, or after
 * 7 days), SCHEMA_WORKER_POLL_MS.
 *
 * Logs carry event names, ids and error codes only: never SQL text, identifiers or values.
 */
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { configPath, databaseUrlFromConfig, readInstallConfigSync } from "../lib/setup/configStore.mjs";
import { tlsConnectionFor } from "../lib/setup/installConnection.mjs";

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
const { rollbackExpandTask } = await import("../lib/schema/runner/expandContract.ts");
const { tryLockModel, unlockModel } = await import("../lib/schema/runner/ledger.ts");
const { trigramSchema } = await import("../lib/schema/engine/render.ts");
const { kyselyOn } = await import("../lib/schema/runner/engine.ts");
const { resyncChangedModels } = await import("../lib/content/contentMove.ts");

const once = process.argv.includes("--once");
// --model <id> or --model=<id>: only that model's stages; contracts then only with --contracts.
const modelFlag = process.argv.indexOf("--model");
const modelValue = modelFlag > 0 ? process.argv[modelFlag + 1] : process.argv.find((arg) => arg.startsWith("--model="))?.slice("--model=".length);
const modelArg = /^[0-9a-f-]{36}$/i.test(modelValue ?? "") ? modelValue : undefined;
const contracts = !modelArg || process.argv.includes("--contracts");
const rollbackArg = process.argv.find((arg) => arg.startsWith("--rollback-task="))?.slice("--rollback-task=".length);
const pollMs = Math.max(250, Number(process.env.SCHEMA_WORKER_POLL_MS || 1500));
const workerId = process.env.SCHEMA_WORKER_ID || `${os.hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
// package.json sits one level above both scripts/ (development) and dist/ (the image's bundle).
function packageVersion() {
  try {
    return JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
  } catch {
    return "unknown";
  }
}
const releaseId = process.env.POLYNOVEA_RELEASE_ID?.trim() || packageVersion();
const log = (event, fields = {}) => console.log(JSON.stringify({ at: new Date().toISOString(), worker: "schema", event, ...fields }));

let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { stopping = true; });

// Where the worker connects, as polynovea_owner, in the same order as run-migrations: the setup
// wizard's config.enc (its owner login, with exactly the wizard's TLS roots), read here in this
// process (the owner credential never passes through the server's environment or command line);
// then POLYNOVEA_MIGRATION_DATABASE_URL / DATABASE_URL (development, installs from before the
// wizard). Exit code 3 means "not set up yet": the server image's entrypoint waits and retries
// instead of crash-looping. A config.enc that exists but cannot be read is an error (exit 1): falling
// back to an environment URL could change a different database than the one the CMS runs on.
const NOT_CONFIGURED_EXIT = 3;
function ownerConnection() {
  let config;
  try {
    config = readInstallConfigSync();
  } catch (error) {
    log("startup_failed", { code: "config_unreadable" });
    console.error(`[schema-worker] ${configPath()} exists but cannot be used (${error instanceof Error ? error.message : String(error)}).`);
    process.exit(1);
  }
  if (config) return { source: "config.enc", connection: tlsConnectionFor(databaseUrlFromConfig(config, "owner"), config.database) };
  if (process.env.POLYNOVEA_MIGRATION_DATABASE_URL || process.env.Database_URL || process.env.DATABASE_URL || process.env.database_url) return { source: "env", connection: undefined };
  log("not_configured", {});
  console.error("[schema-worker] No database yet: finish the setup wizard, or set POLYNOVEA_MIGRATION_DATABASE_URL.");
  process.exit(NOT_CONFIGURED_EXIT);
}
const { source: connectionSource, connection: ownerConnectionSettings } = ownerConnection();

// Built on the first session: search indexes name pg_trgm's operator class in the schema it is installed in.
let engine;
const pool = createOwnerPool(process.env, undefined, ownerConnectionSettings);
// The run's session: kept across polls (it holds the model's advisory lock while a stage runs), and
// replaced when its connection dies (a failover, a restart, pg_terminate_backend). A stage that was
// running is reclaimed and resumed from its run row once the lock went with the old session.
let client;
let clientBroken = false;
async function openSession() {
  const next = await pool.connect();
  next.on("error", () => { clientBroken = true; });
  clientBroken = false;
  await assertOwnerSession(next);
  engine ??= productionEngine(undefined, { trgmSchema: (await trigramSchema(kyselyOn(next))) ?? undefined });
  return next;
}
const CONNECTION_CODES = new Set(["57P01", "57P02", "57P03", "08000", "08001", "08003", "08004", "08006", "ECONNRESET", "ECONNREFUSED", "EPIPE", "ETIMEDOUT"]);
const isConnectionError = (error) => CONNECTION_CODES.has(error?.code) || /connection terminated|connection.*(closed|ended)|not queryable/i.test(String(error?.message ?? ""));
try {
  client = await openSession();
} catch (error) {
  // A code only (e.g. ECONNREFUSED, 28P01): never the connection string.
  const code = typeof error?.code === "string" && /^[0-9A-Z_]{1,40}$/.test(error.code) ? error.code : errorCode(error);
  log("startup_failed", { code });
  await pool.end().catch(() => undefined);
  process.exit(1);
}
try {
  if (rollbackArg) {
    // Operator: undo one failed expand under its model's lock, then exit.
    const { rows: [task] } = await client.query("select content_model_id from public.schema_expand_contract_tasks where id = $1", [rollbackArg]);
    if (!task?.content_model_id || !(await tryLockModel(client, task.content_model_id))) {
      log("rollback_refused", { code: task ? "model_busy" : "expand_task_not_found" });
      process.exitCode = 1;
    } else {
      try {
        await rollbackExpandTask({ client }, rollbackArg);
        log("expand_rolled_back", { taskId: rollbackArg });
      } catch (error) {
        log("rollback_refused", { code: errorCode(error) });
        process.exitCode = 1;
      } finally {
        await unlockModel(client, task.content_model_id);
      }
    }
    stopping = true;
  }
  log("started", { workerId, releaseId, once, model: modelArg ?? null, connection: connectionSource });
  let backoffMs = 0;
  while (!stopping) {
    let worked = false;
    try {
      if (!client) {
        client = await openSession();
        log("reconnected", { workerId });
      }
      // The pool's spare connection watches long CONCURRENTLY statements ("waiting_for_older_transactions").
      const outcome = await runNextStage(client, { engine, workerId, releaseId, log, observer: pool, modelId: modelArg });
      if (outcome) worked = true;
      else if (contracts) await runDueContracts(client, { releaseId, log });
      // Content tables: models whose table changed shape (a stage or a contract) or missed a save are
      // re-synced and re-verified, so their reads return to the table without a manual content:move.
      if (await resyncChangedModels(kyselyOn(client), { modelId: modelArg, log })) worked = true;
      backoffMs = 0;
    } catch (error) {
      const code = typeof error?.code === "string" && /^[0-9A-Z_]{1,40}$/.test(error.code) ? error.code : errorCode(error);
      log("loop_error", { code });
      if (client && (clientBroken || isConnectionError(error))) {
        // Throw the dead session away (never back into the pool) and open a new one after a pause.
        client.release(true);
        client = undefined;
        backoffMs = Math.min(30_000, backoffMs ? backoffMs * 2 : 1_000);
        log("session_lost", { retryInMs: backoffMs });
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
        continue;
      }
      if (!client) {
        backoffMs = Math.min(30_000, backoffMs ? backoffMs * 2 : 1_000);
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
        continue;
      }
    }
    if (once && !worked) break;
    if (!worked) await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
} finally {
  client?.release(clientBroken);
  await pool.end();
  log("stopped", { workerId });
}
