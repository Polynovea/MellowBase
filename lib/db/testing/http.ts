/** Helpers for the database integration tests: timestamp shape and calling route handlers directly. */

/** An ISO timestamp as both drivers return timestamptz values (UTC, "+00:00"). */
export const ISO_TIMESTAMP = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?\+00:00$/;

/** Builds a JSON Request for calling route handlers directly. */
export function jsonRequest(body?: unknown, url = "http://cms.test/api", method = "POST"): Request {
  return new Request(url, body === undefined ? {} : { method, body: JSON.stringify(body), headers: { "content-type": "application/json" } });
}

export const routeParams = <T extends Record<string, string>>(value: T) => ({ params: Promise.resolve(value) });

export async function readJson(response: Response): Promise<{ status: number; body: { success: boolean; data: any; error: string | null } }> {
  return { status: response.status, body: await response.json() };
}

/** Matches database or driver internals that must never reach an API caller. */
export const LEAKED_DB_ERROR = /duplicate key|violates|invalid input syntax|relation "|SQLSTATE|PGRST/i;
