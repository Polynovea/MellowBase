import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";

// Signed, expiring app URLs for storage that has no URL signing of its own (local disk) or whose
// signing cannot bind an upload's size and type (Azure Blob SAS). A token is
//
//   base64url(JSON payload) "." base64url(HMAC-SHA256(signing key, "polynovea-storage-url.v1." + payload))
//
// The payload names the operation, the storage key and, for uploads, the provider, workspace, content
// type and exact byte length, so a token minted for one object or size cannot be used for another.
//
// Signing key: POLYNOVEA_STORAGE_SIGNING_KEY (base64, at least 32 bytes). A comma-separated list is a
// key ring: the first key signs, every key verifies, so a key can be rotated without breaking URLs
// that are still in flight. When it is unset the key is derived from CMS_CONFIG_ENCRYPTION_KEY with
// HKDF under a storage-only label, so the two uses never share key material.

export const UPLOAD_URL_TTL_SECONDS = 15 * 60;
export const READ_URL_TTL_SECONDS = 60 * 60;
const MAX_TTL_SECONDS = 24 * 60 * 60;
const CLOCK_SKEW_SECONDS = 60;
const MAX_TOKEN_LENGTH = 4096;
const SIGNATURE_CONTEXT = "polynovea-storage-url.v1.";

export type StorageTokenPayload =
  | { v: 1; o: "read"; p: "local"; k: string; e: number }
  /** Permanent media link for content: no expiry; `d` says whether the CMS serves it from disk. */
  | { v: 1; o: "media"; p: string; w: string; k: string; d: "local" | "remote" }
  | { v: 1; o: "write"; p: string; w: string; k: string; t: string; n: number; e: number };

export type ReadTokenPayload = Extract<StorageTokenPayload, { o: "read" }>;
export type WriteTokenPayload = Extract<StorageTokenPayload, { o: "write" }>;
export type MediaTokenPayload = Extract<StorageTokenPayload, { o: "media" }>;

type Env = Record<string, string | undefined>;

function decodeKey(raw: string, name: string): Buffer {
  const key = Buffer.from(raw.trim(), "base64");
  if (key.length < 32) throw new Error(`${name} must be base64 for at least 32 random bytes`);
  return key;
}

/** The signing key ring: the first key signs, every key verifies. */
export function storageSigningKeys(env: Env = process.env): Buffer[] {
  const explicit = env.POLYNOVEA_STORAGE_SIGNING_KEY?.trim();
  if (explicit) return explicit.split(",").filter((part) => part.trim()).map((part) => decodeKey(part, "POLYNOVEA_STORAGE_SIGNING_KEY"));
  const master = env.CMS_CONFIG_ENCRYPTION_KEY?.trim();
  if (master) {
    const ikm = Buffer.from(master, "base64");
    if (ikm.length !== 32) throw new Error("CMS_CONFIG_ENCRYPTION_KEY must be a base64-encoded 32-byte key");
    return [Buffer.from(hkdfSync("sha256", ikm, Buffer.alloc(0), "polynovea/storage-url-signing/v1", 32))];
  }
  throw new Error("Signed storage URLs need POLYNOVEA_STORAGE_SIGNING_KEY (or CMS_CONFIG_ENCRYPTION_KEY) to be set");
}

function mac(key: Buffer, body: string) {
  return createHmac("sha256", key).update(SIGNATURE_CONTEXT).update(body).digest();
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

type UnsignedRead = Omit<ReadTokenPayload, "v" | "e">;
type UnsignedWrite = Omit<WriteTokenPayload, "v" | "e">;
type UnsignedMedia = Omit<MediaTokenPayload, "v">;

function seal(full: object, env: Env) {
  const body = Buffer.from(JSON.stringify(full)).toString("base64url");
  return `${body}.${mac(storageSigningKeys(env)[0], body).toString("base64url")}`;
}

export function signStorageToken(payload: UnsignedRead | UnsignedWrite, ttlSeconds: number, env: Env = process.env): string {
  if (!Number.isInteger(ttlSeconds) || ttlSeconds <= 0 || ttlSeconds > MAX_TTL_SECONDS) throw new Error("Signed storage URL lifetime is out of range");
  return seal({ v: 1, ...payload, e: nowSeconds() + ttlSeconds }, env);
}

/**
 * Permanent media link token. Content (rich text, image fields) stores this link, never an expiring
 * read URL. It names one object of one workspace's storage connection and stays valid while the object
 * exists and the signing key stays in the key ring; the link route turns it into a fresh signed read
 * at request time.
 */
export function signMediaToken(payload: UnsignedMedia, env: Env = process.env): string {
  return seal({ v: 1, ...payload }, env);
}

export type VerifyResult<T> = { ok: true; payload: T } | { ok: false; reason: "malformed" | "signature" | "expired" | "operation" };

function isWellFormed(value: unknown): value is StorageTokenPayload {
  if (!value || typeof value !== "object") return false;
  const p = value as Record<string, unknown>;
  if (p.v !== 1 || typeof p.k !== "string") return false;
  if (p.o === "media") return typeof p.p === "string" && typeof p.w === "string" && (p.d === "local" || p.d === "remote") && p.e === undefined;
  if (!Number.isInteger(p.e)) return false;
  if (p.o === "read") return p.p === "local";
  if (p.o === "write") return typeof p.p === "string" && typeof p.w === "string" && typeof p.t === "string" && Number.isSafeInteger(p.n) && (p.n as number) > 0;
  return false;
}

/** Verifies the signature (constant time, against every key in the ring), then the expiry and operation. */
export function verifyStorageToken<O extends StorageTokenPayload["o"]>(token: unknown, operation: O, env: Env = process.env): VerifyResult<Extract<StorageTokenPayload, { o: O }>> {
  if (typeof token !== "string" || token.length > MAX_TOKEN_LENGTH) return { ok: false, reason: "malformed" };
  const dot = token.indexOf(".");
  if (dot <= 0 || dot !== token.lastIndexOf(".")) return { ok: false, reason: "malformed" };
  const body = token.slice(0, dot);
  const signature = token.slice(dot + 1);
  if (!/^[A-Za-z0-9_-]+$/.test(body) || !/^[A-Za-z0-9_-]{43}$/.test(signature)) return { ok: false, reason: "malformed" };
  const supplied = Buffer.from(signature, "base64url");
  let valid = false;
  for (const key of storageSigningKeys(env)) {
    const expected = mac(key, body);
    // Always compare against every key so timing does not reveal which key matched.
    if (supplied.length === expected.length && timingSafeEqual(supplied, expected)) valid = true;
  }
  if (!valid) return { ok: false, reason: "signature" };
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (!isWellFormed(payload)) return { ok: false, reason: "malformed" };
  if (payload.o !== operation) return { ok: false, reason: "operation" };
  if (payload.o === "media") return { ok: true, payload: payload as Extract<StorageTokenPayload, { o: O }> };
  const now = nowSeconds();
  if (payload.e <= now || payload.e > now + MAX_TTL_SECONDS + CLOCK_SKEW_SECONDS) return { ok: false, reason: "expired" };
  return { ok: true, payload: payload as Extract<StorageTokenPayload, { o: O }> };
}

/** Path prefix of the signed routes; the routes live under app/api/storage. */
export const SIGNED_UPLOAD_PATH = "/api/storage/upload";
export const SIGNED_READ_PATH = "/api/storage/files";
export const MEDIA_LINK_PATH = "/api/storage/media";

/**
 * Public URL of this CMS for links that leave the admin (content, public site): the connection's own
 * appUrl override, then POLYNOVEA_PUBLIC_URL. Without either, links are relative to the CMS origin.
 */
export function cmsBaseUrl(override?: string | null, env: Env = process.env): string | null {
  const raw = override?.trim() || env.POLYNOVEA_PUBLIC_URL?.trim();
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("CMS public URL is not a valid URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("CMS public URL must be an http(s) URL");
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

function joinBase(baseUrl: string | null | undefined, path: string) {
  const base = baseUrl?.trim().replace(/\/+$/, "");
  return base ? `${base}${path}` : path;
}

function lastSegment(key: string) {
  return encodeURIComponent(key.slice(key.lastIndexOf("/") + 1));
}

/** Read URL: the token carries the key; the trailing file name is cosmetic (keeps the extension visible). */
export function signedReadUrl(key: string, baseUrl?: string | null, env: Env = process.env) {
  const token = signStorageToken({ o: "read", p: "local", k: key }, READ_URL_TTL_SECONDS, env);
  return joinBase(baseUrl, `${SIGNED_READ_PATH}/${token}/${lastSegment(key)}`);
}

/** Permanent media link for content; see signMediaToken. */
export function mediaLinkUrl(input: { providerKey: string; workspaceId: string; key: string; servedFromDisk: boolean }, baseUrl?: string | null, env: Env = process.env) {
  const token = signMediaToken({ o: "media", p: input.providerKey, w: input.workspaceId, k: input.key, d: input.servedFromDisk ? "local" : "remote" }, env);
  return joinBase(baseUrl, `${MEDIA_LINK_PATH}/${token}/${lastSegment(input.key)}`);
}

export function signedUploadUrl(input: { providerKey: string; workspaceId: string; key: string; contentType: string; contentLength: number }, baseUrl?: string | null, env: Env = process.env) {
  if (!Number.isSafeInteger(input.contentLength) || input.contentLength <= 0) throw new Error("Upload size must be a positive integer");
  const token = signStorageToken({ o: "write", p: input.providerKey, w: input.workspaceId, k: input.key, t: input.contentType, n: input.contentLength }, UPLOAD_URL_TTL_SECONDS, env);
  return joinBase(baseUrl, `${SIGNED_UPLOAD_PATH}/${token}`);
}
