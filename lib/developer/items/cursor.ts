/**
 * Keyset paging cursors for the items API.
 *
 * A cursor is `base64url(JSON {v, s, k, id}) "." base64url(HMAC-SHA256)`. The MAC covers the payload
 * AND the caller (token or principal id), so a cursor is valid only for the caller it was issued to
 * and cannot be edited. On top of the MAC, a decoded cursor is re-checked against the CURRENT request:
 * the sort spec hash must match, every sort key must still be readable by this caller (the spec is
 * re-parsed through its access first), and every value must fit its field's type. Any failure is the
 * same 400 INVALID_CURSOR, which never echoes the cursor's contents.
 *
 * Key: derived from POLYNOVEA_AUTH_SECRET. Without it (Supabase auth installs), a random key per
 * process: cursors then do not survive a restart or cross instances, but are never forgeable.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { ItemsApiError } from "@/lib/developer/items/errors";
import type { ResolvedField } from "@/lib/developer/items/filter";
import type { SortKey } from "@/lib/developer/items/types";

export type CursorValue = string | number | boolean | null;

export interface CursorPayload {
  v: 1;
  /** Hash of the model and sort spec it was issued for. */
  s: string;
  /** The last row's sort values, in sort order. */
  k: CursorValue[];
  /** The last row's entry id and locale (tiebreak: a model table has one row per entry and locale). */
  id: string;
  l?: string;
}

const MAX_CURSOR_LENGTH = 2_048;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
let processKey: Buffer | null = null;

function cursorKey(): Buffer {
  const secret = process.env.POLYNOVEA_AUTH_SECRET;
  if (secret && secret.length >= 32) return createHmac("sha256", secret).update("polynovea.items.cursor.v1").digest();
  processKey ??= randomBytes(32);
  return processKey;
}

const b64 = (buffer: Buffer) => buffer.toString("base64url");

function mac(payload: string, callerId: string, key: Buffer): Buffer {
  return createHmac("sha256", key).update(callerId).update("\u0000").update(payload).digest();
}

/** The spec a cursor belongs to: model, variant and the sort keys with directions. */
export function sortSpecHash(model: string, variant: string, sort: readonly SortKey[]): string {
  return createHash("sha256").update(JSON.stringify([model, variant, sort.map((key) => [key.field, key.direction])])).digest("hex").slice(0, 32);
}

export function encodeCursor(payload: Omit<CursorPayload, "v">, callerId: string, key: Buffer = cursorKey()): string {
  const body = b64(Buffer.from(JSON.stringify({ v: 1, ...payload }), "utf8"));
  return `${body}.${b64(mac(body, callerId, key))}`;
}

const badCursor = () => new ItemsApiError("INVALID_CURSOR", "The cursor is not valid for this request. Start again without a cursor.");

function valueFits(field: ResolvedField, value: CursorValue): boolean {
  if (value === null) return true;
  switch (field.cls) {
    case "boolean": return typeof value === "boolean";
    case "uuid":
    case "relation": return typeof value === "string" && UUID.test(value);
    case "ordered":
      if (field.type === "number" || field.type === "integer") return typeof value === "number" && Number.isFinite(value);
      return typeof value === "string" && value.length <= 64 && !Number.isNaN(Date.parse(value));
    case "text": return typeof value === "string" && value.length <= 10_000;
    default: return false;
  }
}

/**
 * Decodes and checks a cursor for THIS caller and THIS request's sort (already resolved through the
 * caller's access: a key the caller cannot read never gets this far). Throws INVALID_CURSOR.
 */
export function decodeCursor(
  raw: string,
  callerId: string,
  expected: { specHash: string; sort: ReadonlyArray<{ resolved: ResolvedField }> },
  key: Buffer = cursorKey(),
): CursorPayload {
  if (raw.length > MAX_CURSOR_LENGTH) throw badCursor();
  const [body, signature, extra] = raw.split(".");
  if (!body || !signature || extra !== undefined) throw badCursor();
  const expectedMac = mac(body, callerId, key);
  let given: Buffer;
  try {
    given = Buffer.from(signature, "base64url");
  } catch {
    throw badCursor();
  }
  if (given.length !== expectedMac.length || !timingSafeEqual(given, expectedMac)) throw badCursor();
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    throw badCursor();
  }
  const p = payload as Partial<CursorPayload> | null;
  if (!p || p.v !== 1 || p.s !== expected.specHash || typeof p.id !== "string" || !UUID.test(p.id) || !Array.isArray(p.k)) throw badCursor();
  if (p.k.length !== expected.sort.length) throw badCursor();
  if (p.l !== undefined && (typeof p.l !== "string" || !/^[A-Za-z0-9_-]{1,35}$/.test(p.l))) throw badCursor();
  for (let i = 0; i < p.k.length; i += 1) {
    if (!valueFits(expected.sort[i].resolved, p.k[i] as CursorValue)) throw badCursor();
  }
  return p as CursorPayload;
}
