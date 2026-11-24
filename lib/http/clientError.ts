import { randomUUID } from "node:crypto";

// Decides what an API caller may see from a caught error.
//
// Messages written by this codebase for the caller (validation, permission, conflict) pass through.
// Anything that looks like it came from Postgres, PostgREST, a driver, the network, a cloud SDK or the
// JavaScript runtime is replaced by the route's own fallback text plus a reference ID, and the full
// error is logged server-side under that ID. Internals (table and column names, SQL, hostnames, stack
// traces, provider responses) never reach the browser.

type ErrorLike = { message?: unknown; status?: unknown; statusCode?: unknown; code?: unknown; details?: unknown; hint?: unknown; name?: unknown };

const RUNTIME_ERROR_NAMES = new Set(["TypeError", "SyntaxError", "RangeError", "ReferenceError", "EvalError", "URIError", "AbortError", "TimeoutError", "FetchError"]);
const INTERNAL_MESSAGE = new RegExp(
  [
    'relation "', "column \\S+ (?:of relation|does not exist)", "violates \\w+ constraint", "duplicate key value", "syntax error at or near",
    "permission denied for", "row-level security", "invalid input syntax", "could not (?:connect|translate host)", "\\bECONN\\w+", "\\bENOTFOUND\\b",
    "\\bETIMEDOUT\\b", "\\bEAI_AGAIN\\b", "getaddrinfo", "fetch failed", "socket hang up", "certificate", "\\bJWT\\b", "\\bPGRST\\d+", "\\bSQLSTATE\\b",
    "\\n\\s+at ", "Unexpected token", "is not a function", "Cannot read propert", "of undefined", "of null",
  ].join("|"),
  "i",
);

function clientStatus(error: ErrorLike): number | null {
  const status = typeof error.status === "number" ? error.status : typeof error.statusCode === "number" ? error.statusCode : null;
  return status !== null && status >= 400 && status < 500 ? status : null;
}

/** True when the error's message was written for the API caller and is safe to return. */
export function isClientSafeError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as ErrorLike;
  if (typeof candidate.message !== "string" || !candidate.message.trim()) return false;
  if (clientStatus(candidate) !== null) return !INTERNAL_MESSAGE.test(candidate.message);
  if (!(error instanceof Error)) return false; // PostgREST/driver result objects
  if (RUNTIME_ERROR_NAMES.has(error.name)) return false;
  if (candidate.details !== undefined || candidate.hint !== undefined || "$metadata" in error || "errno" in error || "syscall" in error) return false;
  if (typeof candidate.code === "string" && /^[0-9A-Z]{5}$|^PGRST/.test(candidate.code)) return false; // SQLSTATE / PostgREST
  return !INTERNAL_MESSAGE.test(error.message);
}

/**
 * The message to put in an API response for a caught error. Internal errors become
 * `${fallback} (ref XXXXXXXX)` and are logged with that reference.
 */
/** SQLSTATE 25006: the app's login is read-only while an upgrade's new release is on trial. */
export const UPGRADE_IN_PROGRESS = "An upgrade is in progress, so changes are paused for about two minutes. Try again shortly.";

export function isUpgradeReadOnlyError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && (error as ErrorLike).code === "25006");
}

export function clientErrorMessage(error: unknown, fallback = "Request failed"): string {
  if (isUpgradeReadOnlyError(error)) return UPGRADE_IN_PROGRESS;
  if (isClientSafeError(error)) return (error as { message: string }).message;
  const ref = randomUUID().slice(0, 8);
  console.error("[api] %s (ref %s)", fallback, ref, error);
  return `${fallback} (ref ${ref})`;
}
