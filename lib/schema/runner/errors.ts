// Errors of the schema migration runner. Every failure ends as a short code in the ledger
// (error_ref) and in the logs: never SQL text, identifiers or values, which could carry user data or
// tell an attacker about the schema.

/** A code safe to store and log: lowercase letters, digits and underscores. */
export type RunnerErrorCode = string;

const CODE = /^[a-z0-9_]{1,80}$/;

export class RunnerError extends Error {
  readonly code: RunnerErrorCode;
  constructor(code: RunnerErrorCode, message?: string) {
    super(message ?? code);
    this.name = "RunnerError";
    this.code = CODE.test(code) ? code : "internal_error";
  }
}

/** The row was refused before anything ran (tampered, stale or not allowed). */
export class RefusedError extends RunnerError {
  constructor(code: RunnerErrorCode, message?: string) {
    super(code, message);
    this.name = "RefusedError";
  }
}

/** SQLSTATEs that mean "another session holds a lock we need": retried with backoff. */
export const LOCK_CONFLICT_STATES: ReadonlySet<string> = new Set(["55P03", "40P01"]);

const NAMED_STATES: Record<string, string> = {
  "55P03": "lock_timeout_exhausted",
  "40P01": "deadlock_retries_exhausted",
  "23505": "unique_violation",
  "23514": "check_violation",
  "23503": "foreign_key_violation",
  "23502": "not_null_violation",
  "57014": "statement_timeout",
  "42701": "duplicate_column",
  "42703": "undefined_column",
  "42P07": "duplicate_object",
  "42P01": "undefined_table",
  "42501": "insufficient_privilege",
};

export function sqlState(error: unknown): string | null {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^[0-9A-Z]{5}$/.test(code) ? code : null;
}

/** The ledger/log code for any error. */
export function errorCode(error: unknown): RunnerErrorCode {
  if (error instanceof RunnerError) return error.code;
  // The schema engine's errors (SchemaEngineError) carry a code of the same form.
  const code = (error as { name?: unknown; code?: unknown } | null);
  if (code?.name === "SchemaEngineError" && typeof code.code === "string" && CODE.test(code.code)) return code.code;
  const state = sqlState(error);
  if (state) return NAMED_STATES[state] ?? `pg_${state.toLowerCase()}`;
  return "internal_error";
}
