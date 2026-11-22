import pg from "pg";
import { postgresConnectionConfig } from "@/lib/infrastructure/postgresTls.mjs";

/**
 * One pg.Pool per process, shared by every area on the direct path.
 *
 * - Kept on globalThis so Next.js dev reloads and route bundles reuse it instead of leaking pools.
 * - About 10 connections: enough for one server, small enough for a burstable RDS or Azure instance.
 * - Connection, idle, statement, lock and idle-in-transaction timeouts, so one slow query or a stuck
 *   transaction cannot hold the pool.
 * - TLS from postgresTls.mjs: verify-full for anything not on localhost, CA from DATABASE_CA_CERT.
 * - Session TimeZone is UTC and timestamps, dates, bigint and numeric are parsed the way PostgREST
 *   returned them (ISO strings and numbers), so converted areas keep identical return shapes.
 *
 * The runtime connects with POLYNOVEA_DATABASE_URL, which should be the polynovea_app role (rows and
 * functions only, no DDL). DATABASE_URL, which migrations and the worker use, is the fallback while
 * existing installs have a single login.
 */

const DEFAULTS = {
  max: 10,
  connectionTimeoutMillis: 5_000,
  idleTimeoutMillis: 30_000,
  statementTimeoutMillis: 15_000,
  lockTimeoutMillis: 5_000,
  idleInTransactionTimeoutMillis: 30_000,
};

function intFromEnv(name: string, fallback: number, env: Record<string, string | undefined>): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

export function databaseUrlFromEnv(env: Record<string, string | undefined> = process.env): string {
  const url = env.POLYNOVEA_DATABASE_URL?.trim() || env.DATABASE_URL?.trim() || env.Database_URL?.trim();
  if (!url) throw new Error("Database is not configured: set POLYNOVEA_DATABASE_URL");
  return url;
}

// ── PostgREST-compatible type parsing ────────────────────────────────────────

/** "2026-11-22 18:37:00.12+00" (text output, UTC session) → "2026-11-22T18:37:00.12+00:00" (JSON output). */
export function postgresTimestampToIso(value: string): string {
  const iso = value.replace(" ", "T");
  return /[+-]\d\d$/.test(iso) ? `${iso}:00` : iso;
}

function toNumber(value: string): number | string {
  const parsed = Number(value);
  return Number.isFinite(parsed) && (Number.isSafeInteger(parsed) || !/^-?\d+$/.test(value)) ? parsed : value;
}

const OID = {
  int8: 20, numeric: 1700, timestamp: 1114, timestamptz: 1184, date: 1082,
  int8Array: 1016, numericArray: 1231, timestampArray: 1115, timestamptzArray: 1185, dateArray: 1182,
  textArray: 1009,
} as const;

const textArray = pg.types.getTypeParser(OID.textArray as number) as (value: string) => (string | null)[];
const mapArray = (fn: (v: string) => unknown) => (value: string) => textArray(value).map((v) => (v === null ? null : fn(v)));

const PARSERS = new Map<number, (value: string) => unknown>([
  [OID.int8, toNumber],
  [OID.numeric, toNumber],
  [OID.timestamp, postgresTimestampToIso],
  [OID.timestamptz, postgresTimestampToIso],
  [OID.date, (v) => v],
  [OID.int8Array, mapArray(toNumber)],
  [OID.numericArray, mapArray(toNumber)],
  [OID.timestampArray, mapArray(postgresTimestampToIso)],
  [OID.timestamptzArray, mapArray(postgresTimestampToIso)],
  [OID.dateArray, mapArray((v) => v)],
]);

const typeOverrides: pg.CustomTypesConfig = {
  getTypeParser: ((oid: number, format?: string) => {
    if (format !== "binary") {
      const parser = PARSERS.get(oid);
      if (parser) return parser;
    }
    return pg.types.getTypeParser(oid, format as "text");
  }) as pg.CustomTypesConfig["getTypeParser"],
};

// ── Pool ─────────────────────────────────────────────────────────────────────

export function poolConfigFromEnv(env: Record<string, string | undefined> = process.env): pg.PoolConfig {
  const statementTimeout = intFromEnv("POLYNOVEA_DB_STATEMENT_TIMEOUT_MS", DEFAULTS.statementTimeoutMillis, env);
  return {
    ...postgresConnectionConfig(databaseUrlFromEnv(env), env),
    max: intFromEnv("POLYNOVEA_DB_POOL_MAX", DEFAULTS.max, env),
    connectionTimeoutMillis: intFromEnv("POLYNOVEA_DB_CONNECT_TIMEOUT_MS", DEFAULTS.connectionTimeoutMillis, env),
    idleTimeoutMillis: DEFAULTS.idleTimeoutMillis,
    statement_timeout: statementTimeout,
    // A client-side backstop slightly above the server's statement timeout.
    query_timeout: statementTimeout + 5_000,
    lock_timeout: DEFAULTS.lockTimeoutMillis,
    idle_in_transaction_session_timeout: DEFAULTS.idleInTransactionTimeoutMillis,
    application_name: "polynovea-cms",
    options: "-c TimeZone=UTC",
    types: typeOverrides,
  };
}

type PoolHolder = { pool?: pg.Pool };
const holder = globalThis as typeof globalThis & { __polynoveaPgPool?: PoolHolder };

export function getPool(): pg.Pool {
  holder.__polynoveaPgPool ??= {};
  const state = holder.__polynoveaPgPool;
  if (!state.pool) {
    const pool = new pg.Pool(poolConfigFromEnv());
    // An idle client losing its connection must not crash the process; the pool replaces it.
    pool.on("error", (error) => {
      console.error("[db] idle connection error", (error as { code?: string }).code ?? error.name);
    });
    state.pool = pool;
  }
  return state.pool;
}

/** Closes the process pool (tests, graceful shutdown). The next getPool() opens a new one. */
export async function closePool(): Promise<void> {
  const state = holder.__polynoveaPgPool;
  const pool = state?.pool;
  if (!pool) return;
  state.pool = undefined;
  await pool.end();
}
