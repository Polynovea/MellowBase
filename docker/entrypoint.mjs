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
 * 4. Runs the delivery worker once the install has a database. The worker exits with code 3 while
 *    there is none (setup mode); it is retried every 15 seconds, and restarted with a back-off if it
 *    stops for any other reason.
 * 5. On SIGTERM or SIGINT: stops the worker, then the CMS, then PostgreSQL (fast shutdown), in that
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
const WORKER = path.join(APP_DIR, "scripts", "delivery-worker.mjs");
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

// 4. The worker.
let worker = null;
let workerTimer = null;
let failures = 0;
function startWorker() {
  workerTimer = null;
  if (stopping) return;
  const startedAt = Date.now();
  worker = spawn(process.execPath, [WORKER], { cwd: APP_DIR, stdio: "inherit", env: process.env });
  worker.on("exit", (code, signal) => {
    worker = null;
    if (stopping) return;
    if (code === NOT_CONFIGURED_EXIT) {
      failures = 0;
      workerTimer = setTimeout(startWorker, 15_000);
      return;
    }
    failures = Date.now() - startedAt > 60_000 ? 1 : failures + 1;
    const delay = Math.min(60_000, 2_000 * 2 ** Math.min(failures, 5));
    log(`The worker stopped (${signal ?? `exit ${code}`}); restarting in ${Math.round(delay / 1000)}s.`);
    workerTimer = setTimeout(startWorker, delay);
  });
}
if (workerEnabled && existsSync(WORKER)) startWorker();

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
  if (workerTimer) clearTimeout(workerTimer);
  if (worker) {
    worker.kill("SIGTERM");
    await waitForExit(worker, 10_000);
  }
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
