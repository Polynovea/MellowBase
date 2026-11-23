import { Kysely, PostgresDialect, type Transaction } from "kysely";
import type { DB } from "@/lib/db/generated/database";
import { closePool, getPool } from "@/lib/db/pool";

/**
 * The PostgreSQL data layer: every CMS area reads and writes through it.
 *
 * Server-only: never import this from a client component. Every query runs as the runtime role
 * from POLYNOVEA_DATABASE_URL, which can read and write rows and execute functions but not run DDL.
 */

export type Database = DB;
export type Db = Kysely<DB>;
export type DbTransaction = Transaction<DB>;
export type DbExecutor = Db | DbTransaction;

const holder = globalThis as typeof globalThis & { __polynoveaKysely?: Db };

/** The process-wide Kysely instance over the shared pool. */
export function getDb(): Db {
  holder.__polynoveaKysely ??= new Kysely<DB>({ dialect: new PostgresDialect({ pool: getPool() }) });
  return holder.__polynoveaKysely;
}

/**
 * Runs `fn` in one transaction: committed if it resolves, rolled back if it throws.
 * Use it where the Supabase path made several calls in a row and hoped none failed in between.
 */
export async function withTransaction<T>(fn: (trx: DbTransaction) => Promise<T>): Promise<T> {
  return getDb().transaction().execute(fn);
}

/** Closes the Kysely instance and the pool (tests, graceful shutdown). */
export async function closeDb(): Promise<void> {
  const db = holder.__polynoveaKysely;
  holder.__polynoveaKysely = undefined;
  if (db) await db.destroy();
  else await closePool();
}

/** Default cap for list queries. PostgREST capped responses at 1000 rows; direct queries must say so explicitly. */
export const DEFAULT_LIST_LIMIT = 1000;

export { callFunction, SqlFunctionError } from "@/lib/db/functions";
export { expectOne, maybeOne, NotFoundError } from "@/lib/db/rows";
