/**
 * The strict "exactly one row" checks that supabase-js's .single() and .maybeSingle() gave.
 *
 * Errors carry a status so clientErrorMessage passes the message to the caller (it is written
 * here, not by the database) while driver errors stay hidden.
 */

export class NotFoundError extends Error {
  readonly status = 404;
  constructor(message: string) {
    super(message);
    this.name = "NotFoundError";
  }
}

export class MultipleRowsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MultipleRowsError";
  }
}

/** Like .single(): exactly one row, otherwise throws with `message`. */
export function expectOne<T>(rows: readonly T[], message: string): T {
  if (rows.length === 1) return rows[0];
  if (rows.length === 0) throw new NotFoundError(message);
  throw new MultipleRowsError(message);
}

/** Like .maybeSingle(): the row, null for none, throws if there is more than one. */
export function maybeOne<T>(rows: readonly T[], message = "Expected at most one row"): T | null {
  if (rows.length === 0) return null;
  if (rows.length === 1) return rows[0];
  throw new MultipleRowsError(message);
}
