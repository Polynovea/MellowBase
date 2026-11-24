// The migration runner's own connection pool, as polynovea_owner.
//
// Only the migration worker process (scripts/schema-migration-worker.mjs) opens it. The CMS's request
// path uses the app role (lib/db/pool.ts) and never holds owner rights: a request asks for a change by
// writing a ledger row (lib/schema/runner/request.ts), and this pool is what applies it.
// lib/schema/runner/ownerPoolBoundary.test.ts fails if anything outside the runner imports this file,
// and createOwnerPool refuses to open inside the Next.js server.
//
// Connection: POLYNOVEA_MIGRATION_DATABASE_URL, else DATABASE_URL (the login migrations use). It must
// be a DIRECT connection to PostgreSQL (or a session-mode pooler), never a transaction-mode pooler
// such as PgBouncer in transaction mode or Supabase's port 6543: the runner holds a session advisory
// lock for the whole run and builds indexes CONCURRENTLY outside a transaction, and both break when
// consecutive statements may land on different server connections.
import pg from "pg";
import { postgresConnectionConfig } from "@/lib/infrastructure/postgresTls.mjs";
import { LOCK_TIMEOUT_MS } from "@/lib/schema/runner/lockRetry";
import { RunnerError } from "@/lib/schema/runner/errors";

export const OWNER_ROLE = "polynovea_owner";

/** Long enough for VALIDATE and CREATE INDEX CONCURRENTLY on a big table; lock waits stay at 3 s. */
const DEFAULT_STATEMENT_TIMEOUT_MS = 30 * 60_000;

function positiveInt(raw: string | undefined, fallback: number, name: string): number {
  if (!raw?.trim()) return fallback;
  const value = Number(raw.trim());
  if (!Number.isSafeInteger(value) || value <= 0) throw new RunnerError("invalid_runner_config", `${name} must be a positive integer`);
  return value;
}

export function migrationDatabaseUrl(env: Record<string, string | undefined> = process.env): string {
  const url = env.POLYNOVEA_MIGRATION_DATABASE_URL?.trim() || env.DATABASE_URL?.trim() || env.Database_URL?.trim();
  if (!url) throw new RunnerError("runner_not_configured", "Set POLYNOVEA_MIGRATION_DATABASE_URL to the polynovea_owner login");
  return url;
}

export function ownerPoolConfig(env: Record<string, string | undefined> = process.env, url = migrationDatabaseUrl(env)): pg.PoolConfig {
  const statementTimeout = positiveInt(env.POLYNOVEA_MIGRATION_STATEMENT_TIMEOUT_MS, DEFAULT_STATEMENT_TIMEOUT_MS, "POLYNOVEA_MIGRATION_STATEMENT_TIMEOUT_MS");
  return {
    ...postgresConnectionConfig(url, env),
    // One session holds the run (its advisory lock and statements); one spare for the claim loop.
    max: 2,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
    statement_timeout: statementTimeout,
    query_timeout: statementTimeout + 60_000,
    lock_timeout: LOCK_TIMEOUT_MS,
    idle_in_transaction_session_timeout: 5 * 60_000,
    application_name: "polynovea-schema-runner",
    options: "-c TimeZone=UTC",
  };
}

export function createOwnerPool(env: Record<string, string | undefined> = process.env, url?: string): pg.Pool {
  if (env.NEXT_RUNTIME) {
    throw new RunnerError("owner_pool_in_app", "The migration runner's owner pool cannot be opened inside the CMS server");
  }
  const pool = new pg.Pool(ownerPoolConfig(env, url));
  pool.on("error", (error) => {
    console.error("[schema-runner] idle connection error", (error as { code?: string }).code ?? error.name);
  });
  return pool;
}

/**
 * Refuses a session that is not polynovea_owner. POLYNOVEA_MIGRATION_ALLOW_ROLE names another login
 * that owns the content schema (an existing Supabase install migrates as `postgres`).
 */
export async function assertOwnerSession(client: pg.ClientBase, env: Record<string, string | undefined> = process.env): Promise<string> {
  const { rows: [me] } = await client.query<{ role: string; owns_content: boolean }>(
    `select current_user::text as role,
            coalesce((select pg_catalog.pg_has_role(n.nspowner, 'USAGE') from pg_catalog.pg_namespace n where n.nspname = 'content'), false) as owns_content`,
  );
  const allowed = new Set([OWNER_ROLE, env.POLYNOVEA_MIGRATION_ALLOW_ROLE?.trim()].filter(Boolean));
  if (!me || !allowed.has(me.role)) throw new RunnerError("runner_wrong_role", "The migration runner must connect as polynovea_owner");
  if (!me.owns_content) throw new RunnerError("runner_not_schema_owner", "The migration runner's login does not own the content schema");
  return me.role;
}
