// Server-image helpers shared by the restore test, `polynovea-cms system ...` and the worker (plain Node).
// The pgBackRest environment must stay equal to imagePgBackRestEnv in
// lib/setup/database/localServerImage.ts (serverHost.test.ts checks that).

import { execFile } from "node:child_process";
import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import pg from "pg";
import { postgresConnectionConfig } from "../infrastructure/postgresTls.mjs";
import { databaseUrlFromConfig, readInstallConfigSync } from "../setup/configStore.mjs";
import { tlsConnectionFor } from "../setup/installConnection.mjs";

export const STANZA = "polynovea";
export const PG_BIN = "/usr/lib/postgresql/16/bin";
export const LOCAL_DB_SCRIPT = "/opt/polynovea/bin/local-db.sh";
const LOOPBACK = /^(localhost|127(?:\.\d{1,3}){3}|::1|\[::1\])$/i;

/** @param {Record<string, string|undefined>} env */
export function dataRoot(env = process.env) {
  return env.POLYNOVEA_DATA_ROOT?.trim() || "/var/lib/polynovea";
}

/** @param {Record<string, string|undefined>} env */
export function pgBackRestEnv(env = process.env) {
  const root = dataRoot(env);
  return {
    PGBACKREST_CONFIG: path.posix.join(root, "etc", "pgbackrest.conf"),
    PGBACKREST_LOG_PATH: path.posix.join(root, "log", "pgbackrest"),
    PGBACKREST_LOCK_PATH: "/tmp/pgbackrest",
    PGBACKREST_PG1_USER: "postgres",
  };
}

/** True inside the server image with the bundled database's tools. */
export function inServerImage(env = process.env) {
  return env.POLYNOVEA_IMAGE === "1" && existsSync(LOCAL_DB_SCRIPT);
}

/** The install's database settings: config.enc first (as the app), then DATABASE_URL-style variables. */
export function installDatabase(env = process.env) {
  const config = readInstallConfigSync(env);
  if (config) {
    return {
      local: LOOPBACK.test(config.database.host),
      connection: (role) => tlsConnectionFor(databaseUrlFromConfig(config, role), config.database),
      config,
    };
  }
  const url = env.POLYNOVEA_DATABASE_URL?.trim() || env.DATABASE_URL?.trim();
  if (!url) return null;
  const ownerUrl = env.POLYNOVEA_DATABASE_OWNER_URL?.trim() || url;
  return {
    local: LOOPBACK.test(new URL(url).hostname),
    connection: (role) => postgresConnectionConfig(role === "owner" ? ownerUrl : url),
    config: null,
  };
}

/** Runs a program; output is captured, never printed. @returns {Promise<{ code: number, stdout: string, stderr: string }>} */
export function runProgram(file, args, { env = {}, timeoutMs = 60 * 60_000 } = {}) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, encoding: "utf8", env: { ...env, PATH: process.env.PATH ?? "/usr/bin:/bin" } }, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
      resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
    });
  });
}

/** Last lines of a program's error output, with anything that looks like a credential removed. */
export function scrub(text, lines = 3) {
  return String(text ?? "")
    .replace(/(postgres(?:ql)?:\/\/\S+|password=\S+|PGPASSWORD=\S+)/gi, "[redacted]")
    .trim()
    .split("\n")
    .slice(-lines)
    .join(" | ");
}

export function pgbackrest(args, env = process.env, timeoutMs) {
  return runProgram("pgbackrest", [`--stanza=${STANZA}`, ...args], { env: pgBackRestEnv(env), timeoutMs });
}

export async function directorySize(dir) {
  let total = 0;
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += await directorySize(full);
    else if (entry.isFile()) total += (await fs.stat(full).catch(() => ({ size: 0 }))).size;
  }
  return total;
}

export async function freeSpace(dir) {
  const stats = await fs.statfs(dir);
  return { freeBytes: stats.bavail * stats.bsize };
}

export async function withClient(connection, fn) {
  const client = new pg.Client(connection);
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end().catch(() => undefined);
  }
}
