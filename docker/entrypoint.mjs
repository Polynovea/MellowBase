#!/usr/bin/env node
/**
 * The Polynovea server image's main process (run under tini as PID 1).
 *
 * 1. Checks the data disk at /var/lib/polynovea is there and writable by this user.
 * 2. Starts the bundled PostgreSQL only if config.enc says this install uses "On this server" (written
 *    only after the wizard's backups passed). Installs on a managed database never run it, and a
 *    cluster left by a failed attempt stays stopped; the setup wizard starts it the first time.
 * 3. Runs the CMS (Next.js standalone server.js). If it stops, the container stops, so the restart
 *    policy (systemd or Docker) brings everything back cleanly.
 * 4. Runs the two workers once the install has a database: the delivery worker (as polynovea_app)
 *    and the schema migration worker (as polynovea_owner; it applies the model changes the CMS
 *    queues). Each is one bundled JavaScript file (scripts/build-delivery-worker.mjs) and reads
 *    config.enc itself: no credential is passed on their command line or in their environment.
 *    Each exits with code 3 while there is no database (setup mode) and is retried every 15 seconds,
 *    and restarted with a back-off if it stops for any other reason.
 * 5. On SIGTERM or SIGINT: stops the workers, then the CMS, then PostgreSQL (fast shutdown), in that
 *    order, and exits 0.
 *
 * Exit codes: the CMS's own code when it stops by itself; 1 when the data disk is unusable or the
 * bundled database will not start.
 */
import { spawn, spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { bundledDatabaseDecision } from "./entrypoint-lib.mjs";

const APP_DIR = process.env.POLYNOVEA_APP_DIR || "/app";
// Fixed, like lib/setup/database/localServerImage.ts and local-db.sh: no override.
const DATA_ROOT = "/var/lib/polynovea";
const LOCAL_DB = "/opt/polynovea/bin/local-db.sh";
// The bundled workers (scripts/build-delivery-worker.mjs): plain JavaScript, no TypeScript loader.
const WORKERS = [
  { name: "delivery worker", file: path.join(APP_DIR, "dist", "delivery-worker.mjs") },
  { name: "schema worker", file: path.join(APP_DIR, "dist", "schema-migration-worker.mjs") },
];
const NOT_CONFIGURED_EXIT = 3;
const workerEnabled = process.env.POLYNOVEA_WORKER !== "0";

const log = (message) => console.log(`[entrypoint] ${message}`);
const fail = (message) => {
  console.error(`[entrypoint] ${message}`);
  process.exit(1);
};

// 1. The data disk.
try {
  if (!statSync(DATA_ROOT).isDirectory()) throw new Error("not a directory");
  accessSync(DATA_ROOT, constants.W_OK | constants.R_OK | constants.X_OK);
} catch {
  fail(
    `${DATA_ROOT} is missing or not writable by uid ${process.getuid?.()}. Mount the data disk (or a Docker volume) there and make it owned by uid/gid 10001, then start again.`,
  );
}
if (statSync(DATA_ROOT).dev === statSync("/").dev) {
  log(`WARNING: ${DATA_ROOT} is not a separate disk or volume. The master key and settings would be lost with this container. Mount a volume there.`);
}

// 2. The bundled database, only if this install's saved settings say it uses it (entrypoint-lib.mjs).
let localDbStarted = false;
const clusterExists = existsSync(LOCAL_DB) && spawnSync(LOCAL_DB, ["exists"]).status === 0;
let readConfig = () => null;
if (clusterExists) {
  const { readInstallConfigSync } = await import(pathToFileURL(path.join(APP_DIR, "lib", "setup", "configStore.mjs")).href);
  readConfig = () => readInstallConfigSync();
}
const decision = bundledDatabaseDecision({ clusterExists, readConfig });
if (clusterExists) log(decision.reason);
if (decision.start) {
  const started = spawnSync(LOCAL_DB, ["start"], { stdio: "inherit", timeout: 120_000 });
  if (started.status !== 0) fail("The bundled database did not start. Its log is in " + path.join(DATA_ROOT, "log", "postgresql"));
  localDbStarted = true;
}

// 3. The CMS.
let stopping = false;
const server = spawn(process.execPath, [path.join(APP_DIR, "server.js")], { cwd: APP_DIR, stdio: "inherit", env: process.env });
server.on("exit", (code, signal) => {
  if (stopping) return;
  log(`The CMS stopped (${signal ?? `exit ${code}`}); stopping the container.`);
  void shutdown(typeof code === "number" && code !== 0 ? code : 1);
});

// 4. The workers, each supervised on its own.
const supervised = [];
function supervise({ name, file }) {
  const state = { name, child: null, timer: null, failures: 0 };
  supervised.push(state);
  const start = () => {
    state.timer = null;
    if (stopping) return;
    const startedAt = Date.now();
    // The environment is the server's own: no database credential is added for the workers.
    state.child = spawn(process.execPath, [file], { cwd: APP_DIR, stdio: "inherit", env: process.env });
    state.child.on("exit", (code, signal) => {
      state.child = null;
      if (stopping) return;
      if (code === NOT_CONFIGURED_EXIT) {
        state.failures = 0;
        state.timer = setTimeout(start, 15_000);
        return;
      }
      state.failures = Date.now() - startedAt > 60_000 ? 1 : state.failures + 1;
      const delay = Math.min(60_000, 2_000 * 2 ** Math.min(state.failures, 5));
      log(`The ${name} stopped (${signal ?? `exit ${code}`}); restarting in ${Math.round(delay / 1000)}s.`);
      state.timer = setTimeout(start, delay);
    });
  };
  start();
}
if (workerEnabled) for (const worker of WORKERS) if (existsSync(worker.file)) supervise(worker);

// 5. Shutdown.
function waitForExit(child, ms) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return resolve();
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, ms);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function shutdown(code) {
  if (stopping) return;
  stopping = true;
  for (const state of supervised) if (state.timer) clearTimeout(state.timer);
  await Promise.all(supervised.map(async (state) => {
    if (!state.child) return;
    state.child.kill("SIGTERM");
    await waitForExit(state.child, 10_000);
  }));
  if (server.exitCode === null && server.signalCode === null) {
    server.kill("SIGTERM");
    await waitForExit(server, 20_000);
  }
  // The wizard may have started the bundled database during this run, so check rather than rely on localDbStarted.
  if (localDbStarted || (existsSync(LOCAL_DB) && spawnSync(LOCAL_DB, ["status"]).status === 0)) {
    spawnSync(LOCAL_DB, ["stop"], { stdio: "inherit", timeout: 70_000 });
  }
  process.exit(code);
}

process.on("SIGTERM", () => void shutdown(0));
process.on("SIGINT", () => void shutdown(0));
