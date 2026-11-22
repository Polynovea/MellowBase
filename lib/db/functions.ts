import { sql, type RawBuilder } from "kysely";
import { SQL_FUNCTIONS, type SqlFunctions } from "@/lib/db/generated/functions";
import { getDb, type DbExecutor } from "@/lib/db/index";

export type SqlFunctionName = keyof SqlFunctions;
export type SqlFunctionArgs<N extends SqlFunctionName> = SqlFunctions[N]["args"];
type Shape<N extends SqlFunctionName> = SqlFunctions[N]["shape"];
type Returns<N extends SqlFunctionName> = SqlFunctions[N]["returns"];

/** What callFunction resolves to, matching what supabase-js .rpc() returned as `data`. */
export type SqlFunctionResult<N extends SqlFunctionName> =
  Shape<N> extends "rows" | "scalars" ? Returns<N>[]
  : Shape<N> extends "row" ? Returns<N> | null
  : Shape<N> extends "void" ? null
  : Returns<N>;

/**
 * An exception our own SQL function raised on purpose (`raise exception '...'`, SQLSTATE P0001),
 * such as "Cannot merge terms from different taxonomies". Over PostgREST these messages reached the
 * API caller; keeping them as a plain Error (no SQLSTATE) preserves that for converted areas.
 * clientErrorMessage still hides any message that looks internal.
 */
export class SqlFunctionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SqlFunctionError";
  }
}

/**
 * True for an exception our own SQL raised on purpose. Plain `raise exception` uses SQLSTATE P0001,
 * but many functions pick their own (`using errcode = 'P0002'`, '22023', '40300', ...), and
 * PostgREST passed all of those messages to the caller. The server marks them in the error's
 * context: the innermost line is "PL/pgSQL function ... at RAISE". Errors from a statement inside a
 * function (constraint violations, bad input) end "at SQL statement" and stay hidden.
 */
function isRaisedException(error: unknown): error is { message: string } {
  if (!error || typeof error !== "object") return false;
  const { code, message, where } = error as { code?: unknown; message?: unknown; where?: unknown };
  if (typeof message !== "string") return false;
  if (code === "P0001") return true;
  return typeof where === "string" && /^PL\/pgSQL function [^\n]* at RAISE$/m.test(where.split("\n")[0] ?? "");
}

/**
 * Calls one of the SQL functions in schema public by name, with named arguments, the way
 * `.rpc(name, args)` did. The function name and argument names are checked against the generated
 * registry (lib/db/generated/functions.ts), and identifiers are always quoted, never concatenated.
 *
 * Pass a transaction as `executor` to run the call inside withTransaction().
 */
export async function callFunction<N extends SqlFunctionName>(
  name: N,
  args: SqlFunctionArgs<N>,
  executor?: DbExecutor,
): Promise<SqlFunctionResult<N>> {
  const definition = SQL_FUNCTIONS[name];
  if (!definition) throw new Error(`Unknown SQL function: ${String(name)}`);

  const argEntries = Object.entries(args as Record<string, unknown>).filter(([, value]) => value !== undefined);
  for (const [argName] of argEntries) {
    if (!definition.argNames.includes(argName)) throw new Error(`Unknown argument ${argName} for SQL function ${String(name)}`);
  }

  const call: RawBuilder<unknown> = sql`${sql.id("public", name)}(${sql.join(
    argEntries.map(([argName, value]) => sql`${sql.id(argName)} => ${value}`),
  )})`;

  const db = executor ?? getDb();
  try {
    switch (definition.shape) {
      case "rows": {
        const { rows } = await sql`select * from ${call} as result`.execute(db);
        return rows as SqlFunctionResult<N>;
      }
      case "row": {
        const { rows } = await sql`select * from ${call} as result`.execute(db);
        // A function returning one composite value that returns NULL still yields one row from
        // `select * from f()`, with every column NULL. That is SQL's own "row is null", so report null.
        const row = rows[0] as Record<string, unknown> | undefined;
        if (!row || Object.values(row).every((value) => value === null)) return null as SqlFunctionResult<N>;
        return row as SqlFunctionResult<N>;
      }
      case "scalars": {
        const { rows } = await sql<{ value: unknown }>`select ${call} as value`.execute(db);
        return rows.map((row) => row.value) as SqlFunctionResult<N>;
      }
      case "void": {
        await sql`select ${call}`.execute(db);
        return null as SqlFunctionResult<N>;
      }
      default: {
        const { rows } = await sql<{ value: unknown }>`select ${call} as value`.execute(db);
        return (rows[0]?.value ?? null) as SqlFunctionResult<N>;
      }
    }
  } catch (error) {
    if (isRaisedException(error)) throw new SqlFunctionError(error.message);
    throw error;
  }
}
