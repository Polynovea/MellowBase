import pg from "pg";
import { postgresConnectionConfig } from "@/lib/infrastructure/postgresTls.mjs";
import { currentMode, runtimeDatabaseUrl } from "@/lib/setup/mode";

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
 * The runtime connects as the polynovea_app role (rows and functions only, no DDL): from config.enc
 * when the setup wizard wrote one, otherwise POLYNOVEA_DATABASE_URL, with DATABASE_URL (which
 * migrations and the worker use) as the fallback while existing installs have a single login.
 *
 * Setup mode (lib/setup/mode.ts): getPool() refuses to open the pool, and the pool refuses every
 * connection, while the CMS is in setup or unavailable mode. This is the layer under middleware.ts,
 * which alone can be bypassed (CVE-2025-29927). The wizard's own steps use getSetupPool(), which only
 * works in setup mode.
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
  return poolConfigFor(databaseUrlFromEnv(env), env);
}

export function poolConfigFor(url: string, env: Record<string, string | undefined> = process.env): pg.PoolConfig {
  const statementTimeout = intFromEnv("POLYNOVEA_DB_STATEMENT_TIMEOUT_MS", DEFAULTS.statementTimeoutMillis, env);
  return {
    ...postgresConnectionConfig(url, env),
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

/** Thrown when the database is used in a mode that does not allow it. Not safe to show to clients. */
export class PoolModeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PoolModeError";
  }
}

type Purpose = "runtime" | "setup";

/** Runtime: refused in setup and unavailable modes. Setup: only in setup mode. Undecided (scripts, tests): allowed. */
function assertPoolAllowed(purpose: Purpose) {
  const mode = currentMode();
  if (purpose === "setup") {
    if (mode !== "setup") throw new PoolModeError("The setup database pool is only available in setup mode");
    return;
  }
  if (mode === "setup") throw new PoolModeError("The CMS is in setup mode: the database is not open until setup is finished");
  if (mode === "unavailable") throw new PoolModeError("The CMS database is unavailable");
}

/** A pool that re-checks the mode on every checkout, so a pool opened earlier cannot be used later in the wrong mode. */
class ModeGuardedPool extends pg.Pool {
  constructor(config: pg.PoolConfig, private readonly purpose: Purpose) {
    super(config);
  }

  // pg.Pool.query() checks out through connect(), so this covers both.
  connect(...args: unknown[]): never {
    assertPoolAllowed(this.purpose);
    return (super.connect as (...a: unknown[]) => never)(...args);
  }
}

function openPool(purpose: Purpose, max?: number): pg.Pool {
  const url = runtimeDatabaseUrl();
  if (!url) throw new Error("Database is not configured: finish setup at /setup, or set POLYNOVEA_DATABASE_URL");
  const config = poolConfigFor(url);
  const pool = new ModeGuardedPool(max ? { ...config, max } : config, purpose);
  // An idle client losing its connection must not crash the process; the pool replaces it.
  pool.on("error", (error) => {
    console.error("[db] idle connection error", (error as { code?: string }).code ?? error.name);
  });
  return pool;
}

type PoolHolder = { pool?: pg.Pool; setupPool?: pg.Pool };
const holder = globalThis as typeof globalThis & { __polynoveaPgPool?: PoolHolder };

export function getPool(): pg.Pool {
  holder.__polynoveaPgPool ??= {};
  const state = holder.__polynoveaPgPool;
  if (!state.pool) {
    assertPoolAllowed("runtime");
    state.pool = openPool("runtime");
  }
  return state.pool;
}

/**
 * The database for the wizard's own steps (owner and installation row), as the app role. Only in
 * setup mode; a small pool, closed by closePool().
 */
export function getSetupPool(): pg.Pool {
  holder.__polynoveaPgPool ??= {};
  const state = holder.__polynoveaPgPool;
  assertPoolAllowed("setup");
  state.setupPool ??= openPool("setup", 2);
  return state.setupPool;
}

/** Closes the process pools (tests, graceful shutdown, end of setup). The next getPool() opens a new one. */
export async function closePool(): Promise<void> {
  const state = holder.__polynoveaPgPool;
  if (!state) return;
  const pools = [state.pool, state.setupPool].filter((pool): pool is pg.Pool => Boolean(pool));
  state.pool = undefined;
  state.setupPool = undefined;
  await Promise.all(pools.map((pool) => pool.end()));
}
