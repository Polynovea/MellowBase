/**
 * Helpers for dual-backend tests that check both backends return identical results: values are
 * recorded per backend with IDs replaced by first-seen order and timestamps by a marker, then a
 * final test compares the two recordings.
 *
 *   const recorder = createRecorder();
 *   describeBothBackends("area", "...", (backend) => { ... recorder.record(backend.name, "case", value); });
 *   describe("area backends agree", () => { it("...", () => recorder.expectAgreement()); });
 */
import { expect } from "vitest";
import type { DataBackend } from "@/lib/db/backend";

export const ISO_TIMESTAMP = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?\+00:00$/;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

const sortKeys = (value: unknown): unknown =>
  Array.isArray(value) ? value.map(sortKeys)
  : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, sortKeys(v)]))
  : value;

/** IDs become <id1>, <id2>… by first appearance; ISO timestamps become "<timestamp>". */
export function normalizeForComparison(value: unknown): unknown {
  const ids = new Map<string, string>();
  return JSON.parse(JSON.stringify(sortKeys(value)), (_key, v) => {
    if (typeof v !== "string") return v;
    if (ISO_TIMESTAMP.test(v)) return "<timestamp>";
    return v.replace(UUID, (id) => {
      if (!ids.has(id)) ids.set(id, `<id${ids.size + 1}>`);
      return ids.get(id)!;
    });
  });
}

export function createRecorder() {
  const recorded: Partial<Record<DataBackend, Record<string, unknown>>> = {};
  return {
    record(backend: DataBackend, name: string, value: unknown) {
      recorded[backend] ??= {};
      recorded[backend]![name] = normalizeForComparison(value);
    },
    expectAgreement() {
      expect(recorded.supabase).toBeDefined();
      expect(recorded.postgres).toEqual(recorded.supabase);
    },
  };
}

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
