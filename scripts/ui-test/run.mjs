#!/usr/bin/env node
// Runs the admin UI end-to-end tests (e2e/ui, playwright.ui.config.ts) against a production build on
// built-in auth, from a fresh database:
//
//   1. node scripts/dev-db/setup.mjs --reset          a fresh, migrated PostgreSQL 16 with no owner
//   2. next build with NEXT_PUBLIC_AUTH_PROVIDER=builtin
//   3. next start on 127.0.0.1 in setup mode (a known setup code), and the schema migration worker
//   4. Playwright, one stage at a time: wizard + signin (stop if they fail), flows, audit, signout
//   5. node scripts/ui-test/summarise.mjs             docs/ui-audit/automated-checks.md
//   6. stop the server and the worker, node scripts/dev-db/setup.mjs --down
//
// Usage: node scripts/ui-test/run.mjs [--skip-build] [--keep-stack] [--only=<stage,...>]
//   --skip-build   reuse the last .next build (it must have been built by this script)
//   --keep-stack   leave the database running afterwards (default: taken down)
//   --only         run only these Playwright stages (wizard needs a fresh stack; the others need the
//                  state a previous run left in UI_STATE_DIR)
//
// Heavy (Docker, a database, a build, a browser). Local test only: every secret here is random per run,
// lives in this process's environment or in UI_STATE_DIR (outside the repo, deleted at the end unless
// UI_STATE_DIR was given), and protects services bound to 127.0.0.1.
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const only = args.find((arg) => arg.startsWith("--only="))?.slice("--only=".length).split(",").filter(Boolean);
const PORT = Number(process.env.UI_PORT ?? 3100);
const BASE_URL = `http://localhost:${PORT}`;
const isWindows = process.platform === "win32";

const givenStateDir = process.env.UI_STATE_DIR;
const stateDir = givenStateDir ?? mkdtempSync(path.join(os.tmpdir(), "polynovea-ui-"));
mkdirSync(stateDir, { recursive: true });
const log = (message) => console.log(`[ui-test ${new Date().toISOString().slice(11, 19)}] ${message}`);

function readEnvFile(file) {
  const values = {};
  for (const raw of readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    const eq = line.indexOf("=");
    if (line && !line.startsWith("#") && eq > 0) values[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return values;
}

/** 26 Crockford base32 characters: 130 random bits, what POLYNOVEA_SETUP_CODE accepts. */
function setupCode() {
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  return [...randomBytes(26)].map((byte) => alphabet[byte % 32]).join("");
}

function run(command, commandArgs, options = {}) {
  log(`$ ${command} ${commandArgs.join(" ")}`);
  execFileSync(command, commandArgs, { stdio: "inherit", cwd: root, shell: isWindows && command === "npm", ...options });
}

const children = [];
/** Starts a long-running Node process (the server, the worker) with its output in UI_STATE_DIR/<name>.log. */
function startNode(name, nodeArgs, env) {
  const out = createWriteStream(path.join(stateDir, `${name}.log`));
  const child = spawn(process.execPath, nodeArgs, { cwd: root, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  child.stdout.pipe(out);
  child.stderr.pipe(out);
  children.push({ name, child });
  log(`started ${name} (pid ${child.pid}), log: ${path.join(stateDir, `${name}.log`)}`);
  return child;
}

function stopAll() {
  for (const { name, child } of children.splice(0)) {
    if (child.exitCode !== null) continue;
    log(`stopping ${name} (pid ${child.pid})`);
    try {
      if (isWindows) execFileSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      else child.kill("SIGTERM");
    } catch { /* already gone */ }
  }
}

async function waitFor(url, test, timeoutMs) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      const response = await fetch(url);
      if (await test(response)) return;
    } catch { /* not up yet */ }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`${url} did not come up within ${Math.round(timeoutMs / 1000)} s`);
}

let failed = false;
let stackUp = false;
const cleanup = () => {
  stopAll();
  if (stackUp && !flag("keep-stack")) {
    try { run(process.execPath, ["scripts/dev-db/setup.mjs", "--down"]); } catch (error) { console.error(`dev-db --down failed: ${error.message}`); }
    stackUp = false;
  }
  if (!givenStateDir) rmSync(stateDir, { recursive: true, force: true });
};
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => { cleanup(); process.exit(130); });

try {
  const stages = only ?? ["wizard", "flows", "audit", "signout"];

  // 1. A fresh database (the wizard needs one without an owner), and no results from an earlier run:
  // the audit's final gate reads every recorded screen.
  if (stages.includes("wizard")) {
    rmSync(path.join(root, "test-results", "ui"), { recursive: true, force: true });
    run(process.execPath, ["scripts/dev-db/setup.mjs", "--reset", "--pg=16"]);
  } else {
    run(process.execPath, ["scripts/dev-db/setup.mjs", "--pg=16"]);
  }
  stackUp = true;
  const testEnv = readEnvFile(path.join(root, ".env.test.local"));

  const code = process.env.UI_SETUP_CODE ?? setupCode();
  const storageDir = path.join(stateDir, "storage");
  const configDir = path.join(stateDir, "config");
  mkdirSync(storageDir, { recursive: true });
  mkdirSync(configDir, { recursive: true });
  const appEnv = {
    ...process.env,
    NODE_ENV: "production",
    AUTH_PROVIDER: "builtin",
    NEXT_PUBLIC_AUTH_PROVIDER: "builtin",
    POLYNOVEA_AUTH_SECRET: process.env.UI_AUTH_SECRET ?? randomBytes(36).toString("base64url"),
    CMS_MASTER_KEY: process.env.UI_MASTER_KEY ?? `k1:${randomBytes(32).toString("base64")}`,
    POLYNOVEA_PUBLIC_URL: BASE_URL,
    POLYNOVEA_TRUSTED_PROXIES: "127.0.0.1",
    POLYNOVEA_HIBP_DISABLED: "true",
    POLYNOVEA_DATABASE_URL: testEnv.POLYNOVEA_TEST_POSTGRES_URL,
    POLYNOVEA_CONFIG_DIR: configDir,
    POLYNOVEA_STORAGE_DIR: storageDir,
    POLYNOVEA_SETUP_CODE: code,
    HOSTNAME: "127.0.0.1",
    PORT: String(PORT),
  };
  // Settings from older runs or other setups must not leak in: this run is built-in auth on plain PostgreSQL.
  for (const key of ["DATABASE_URL", "NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY"]) delete appEnv[key];

  // 2. The production build.
  if (!flag("skip-build")) run("npm", ["run", "build"], { env: appEnv });

  // 3. The server in setup mode, and the schema worker (owner login, like the image runs it).
  startNode("server", ["node_modules/next/dist/bin/next", "start", "-p", String(PORT), "-H", "127.0.0.1"], appEnv);
  await waitFor(`http://127.0.0.1:${PORT}/api/health`, (response) => response.ok, 120_000);
  startNode("schema-worker", ["--loader", "./scripts/phase12_75-node-loader.mjs", "scripts/schema-migration-worker.mjs"], {
    ...appEnv,
    POLYNOVEA_MIGRATION_DATABASE_URL: testEnv.POLYNOVEA_TEST_POSTGRES_OWNER_URL,
    SCHEMA_WORKER_POLL_MS: "1000",
  });

  // 4. Playwright, stage by stage.
  const playwright = (stage, projects) => {
    try {
      run(process.execPath, ["node_modules/@playwright/test/cli.js", "test", "-c", "playwright.ui.config.ts", "--no-deps", ...projects.flatMap((p) => ["--project", p])], {
        env: { ...process.env, UI_STAGE: stage, UI_STATE_DIR: stateDir, UI_SETUP_CODE: code, UI_BASE_URL: BASE_URL, AUTH_PROVIDER: "builtin" },
      });
      return true;
    } catch {
      failed = true;
      log(`stage ${stage} had failures`);
      return false;
    }
  };
  if (stages.includes("wizard")) playwright("setup", ["wizard", "signin"]);
  // The later stages need the signed-in owner that sign-in saves; a soft failure earlier (an axe
  // finding on a wizard screen, say) must not skip them.
  const signedIn = existsSync(path.join(stateDir, "signed-in.json"));
  if (!signedIn) {
    log("the wizard or sign-in failed: the other stages need the owner they create, so they are skipped");
  } else {
    for (const stage of ["flows", "audit", "signout"]) if (stages.includes(stage)) playwright(stage, [stage]);
  }

  // 5. The automated-checks summary.
  run(process.execPath, ["scripts/ui-test/summarise.mjs"]);
} catch (error) {
  failed = true;
  console.error(error instanceof Error ? error.message : error);
  for (const name of ["server", "schema-worker"]) {
    const file = path.join(stateDir, `${name}.log`);
    if (existsSync(file)) console.error(`--- last lines of ${name}.log ---\n${readFileSync(file, "utf8").split("\n").slice(-40).join("\n")}`);
  }
} finally {
  cleanup();
}
log(failed ? "finished with failures" : "finished: all stages passed");
process.exit(failed ? 1 : 0);
