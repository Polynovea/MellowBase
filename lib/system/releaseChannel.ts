import { createHash, createPublicKey, verify as verifySignature, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";
import { safeFetch } from "@/lib/infrastructure/networkSafety";

/**
 * Checks a release channel for a newer signed Polynovea release (System page).
 *
 * The channel is any HTTPS folder the operator names in POLYNOVEA_RELEASE_CHANNEL_URL; no Polynovea
 * service is assumed. It holds:
 *
 *   latest.json        {"schema":1,"releaseId":"0.4.1+abc1234","release":"0.4.1/release.json","signature":"0.4.1/release.json.sig"}
 *   <release.json>     written and signed by scripts/release/build-and-sign.mjs (schema 1)
 *   <release.json.sig> `cosign sign-blob` output: base64 of an ECDSA P-256 / SHA-256 signature (DER)
 *   <changelog>        optional, named with its SHA-256 inside release.json
 *
 * latest.json is only a pointer and is not trusted: nothing is shown until release.json's signature
 * verifies with the installed release public key (the same file the host agent and verify-images.sh
 * use). The changelog is shown only when its hash matches the signed release.json.
 *
 * Every fetch: HTTPS only (redirects included, through safeFetch), no private addresses, a size cap and
 * a timeout. POLYNOVEA_RELEASE_CHANNEL_ALLOW_LOCAL=1 (tests only) allows http on loopback.
 *
 * Nothing here starts an upgrade: an admin does, from the System page.
 */

type Env = Record<string, string | undefined>;

export const DEFAULT_PUBLIC_KEY_FILE = "/etc/polynovea/release.pub";
export const FETCH_TIMEOUT_MS = 10_000;
export const LIMITS = { pointer: 4 * 1024, release: 64 * 1024, signature: 1024, changelog: 256 * 1024 } as const;

const RELEASE_ID = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,127}$/;
const SEMVER = /^(\d{1,6})\.(\d{1,6})\.(\d{1,6})(?:-([0-9A-Za-z.-]{1,64}))?(?:\+[0-9A-Za-z.-]{1,64})?$/;
const RELATIVE_PATH = /^[A-Za-z0-9_+-][A-Za-z0-9._+-]*(\/[A-Za-z0-9_+-][A-Za-z0-9._+-]*)*$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const IMAGE = /^[a-z0-9][a-z0-9./:_-]{0,254}$/;
const HEX64 = /^[0-9a-f]{64}$/;

export type RollbackMode = "compatible" | "restore";

export interface VerifiedRelease {
  releaseId: string;
  version: string;
  image: string;
  digest: string;
  /** "compatible": the previous release runs on this release's schema; anything else is "restore". */
  rollback: RollbackMode;
  createdAt: string | null;
  changelog: string | null;
}

export interface ChannelCheck {
  configured: boolean;
  current: { releaseId: string | null; version: string | null };
  latest: VerifiedRelease | null;
  upgradeAvailable: boolean;
  /** A plain message for the System page; never a URL with credentials or a raw network error. */
  error: string | null;
}

export class ReleaseChannelError extends Error {}

export function compareVersions(a: string, b: string): number {
  const x = SEMVER.exec(a);
  const y = SEMVER.exec(b);
  if (!x || !y) throw new ReleaseChannelError("A version is not a valid semantic version.");
  for (let i = 1; i <= 3; i++) {
    const diff = Number(x[i]) - Number(y[i]);
    if (diff) return Math.sign(diff);
  }
  // A pre-release sorts before its release; two pre-releases compare identifier by identifier.
  if (!x[4] && !y[4]) return 0;
  if (!x[4]) return 1;
  if (!y[4]) return -1;
  const xa = x[4].split(".");
  const ya = y[4].split(".");
  for (let i = 0; i < Math.max(xa.length, ya.length); i++) {
    if (xa[i] === undefined) return -1;
    if (ya[i] === undefined) return 1;
    const xn = /^\d+$/.test(xa[i]);
    const yn = /^\d+$/.test(ya[i]);
    if (xn && yn && Number(xa[i]) !== Number(ya[i])) return Math.sign(Number(xa[i]) - Number(ya[i]));
    if (xn !== yn) return xn ? -1 : 1;
    if (xa[i] !== ya[i]) return xa[i] < ya[i] ? -1 : 1;
  }
  return 0;
}

/** The running release (the image's POLYNOVEA_RELEASE_ID, "<version>+<commit>"); nulls outside an image. */
export function currentRelease(env: Env = process.env): { releaseId: string | null; version: string | null } {
  const releaseId = env.POLYNOVEA_RELEASE_ID?.trim() ?? "";
  if (!RELEASE_ID.test(releaseId)) return { releaseId: null, version: null };
  const version = releaseId.split("+")[0];
  return { releaseId, version: SEMVER.test(version) ? version : null };
}

export function loadReleasePublicKey(env: Env = process.env, read: (file: string) => string = (file) => readFileSync(file, "utf8")): { key: KeyObject; sha256: string } | null {
  const file = env.POLYNOVEA_RELEASE_PUBKEY_FILE?.trim() || DEFAULT_PUBLIC_KEY_FILE;
  let pem: string;
  try {
    pem = read(file);
  } catch {
    return null;
  }
  if (!pem.includes("BEGIN PUBLIC KEY")) return null;
  const key = createPublicKey(pem);
  if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") {
    throw new ReleaseChannelError("The release public key is not an ECDSA P-256 key.");
  }
  return { key, sha256: createHash("sha256").update(pem).digest("hex") };
}

/**
 * Checks a `cosign sign-blob` signature: base64 text (whitespace around it allowed) of a DER ECDSA
 * signature over SHA-256 of the exact file bytes. Anything else is refused.
 */
export function verifyBlobSignature(blob: Buffer, signatureText: string, key: KeyObject): boolean {
  const text = signatureText.trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(text) || text.length > 200) return false;
  const signature = Buffer.from(text, "base64");
  if (signature.length < 8 || signature[0] !== 0x30) return false;
  try {
    return verifySignature("sha256", blob, { key, dsaEncoding: "der" }, signature);
  } catch {
    return false;
  }
}

async function fetchCapped(url: string, limit: number, env: Env): Promise<Buffer> {
  const kind = env.POLYNOVEA_RELEASE_CHANNEL_ALLOW_LOCAL === "1" && env.NODE_ENV !== "production" ? "local" : "production";
  let response: Response;
  try {
    response = await safeFetch(url, kind, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), headers: { accept: "application/json, text/plain" } }, 2);
  } catch (error) {
    throw new ReleaseChannelError(error instanceof Error && /HTTPS|private|resolve|redirect|invalid|Credentials/i.test(error.message) ? `The release channel refused: ${error.message}.` : "The release channel could not be reached.");
  }
  if (!response.ok) throw new ReleaseChannelError(`The release channel answered ${response.status}.`);
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > limit) throw new ReleaseChannelError("A release channel file is larger than allowed.");
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => undefined);
      throw new ReleaseChannelError("A release channel file is larger than allowed.");
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

function parseJson(bytes: Buffer, what: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new ReleaseChannelError(`${what} is not valid JSON.`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ReleaseChannelError(`${what} is not a JSON object.`);
  return value as Record<string, unknown>;
}

function childUrl(base: URL, relative: unknown, what: string): string {
  if (typeof relative !== "string" || !RELATIVE_PATH.test(relative) || relative.split("/").some((part) => part === "." || part === "..")) {
    throw new ReleaseChannelError(`latest.json names an invalid ${what} path.`);
  }
  const url = new URL(relative, base);
  if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname)) throw new ReleaseChannelError(`latest.json's ${what} is outside the channel.`);
  return url.toString();
}

/** Validates a verified release.json (schema 1). */
export function parseRelease(release: Record<string, unknown>, expectedReleaseId: string, publicKeySha256: string): Omit<VerifiedRelease, "changelog"> & { changelogFile: { file: string; sha256: string } | null } {
  if (release.schema !== 1) throw new ReleaseChannelError("release.json has an unknown schema.");
  const { releaseId, version, image, digest } = release as Record<string, string>;
  if (typeof releaseId !== "string" || !RELEASE_ID.test(releaseId) || releaseId !== expectedReleaseId) throw new ReleaseChannelError("release.json does not match latest.json.");
  if (typeof version !== "string" || !SEMVER.test(version) || releaseId.split("+")[0] !== version) throw new ReleaseChannelError("release.json has an invalid version.");
  if (typeof image !== "string" || !IMAGE.test(image) || image.includes("@")) throw new ReleaseChannelError("release.json has an invalid image name.");
  if (typeof digest !== "string" || !DIGEST.test(digest)) throw new ReleaseChannelError("release.json has an invalid image digest.");
  if (release.publicKeySha256 !== undefined && release.publicKeySha256 !== publicKeySha256) {
    throw new ReleaseChannelError("release.json was made for a different release key than the one installed.");
  }
  let changelogFile: { file: string; sha256: string } | null = null;
  if (release.changelog !== undefined && release.changelog !== null) {
    const entry = release.changelog as Record<string, unknown>;
    if (typeof entry !== "object" || typeof entry.file !== "string" || typeof entry.sha256 !== "string" || !HEX64.test(entry.sha256)) {
      throw new ReleaseChannelError("release.json has an invalid changelog entry.");
    }
    changelogFile = { file: entry.file, sha256: entry.sha256 };
  }
  return {
    releaseId,
    version,
    image,
    digest,
    rollback: release.rollback === "compatible" ? "compatible" : "restore",
    createdAt: typeof release.createdAt === "string" ? release.createdAt : null,
    changelogFile,
  };
}

/** Fetches latest.json, release.json and its signature, verifies, and returns the verified release. */
export async function fetchLatestRelease(env: Env = process.env, readKey = loadReleasePublicKey): Promise<VerifiedRelease | null> {
  const channel = env.POLYNOVEA_RELEASE_CHANNEL_URL?.trim();
  if (!channel) return null;
  let base: URL;
  try {
    base = new URL(channel.endsWith("/") ? channel : `${channel}/`);
  } catch {
    throw new ReleaseChannelError("POLYNOVEA_RELEASE_CHANNEL_URL is not a valid URL.");
  }
  if (base.username || base.password || base.search || base.hash) throw new ReleaseChannelError("POLYNOVEA_RELEASE_CHANNEL_URL must not carry credentials, a query or a fragment.");
  const publicKey = readKey(env);
  if (!publicKey) throw new ReleaseChannelError("No release public key is installed, so releases cannot be verified.");

  const pointer = parseJson(await fetchCapped(new URL("latest.json", base).toString(), LIMITS.pointer, env), "latest.json");
  if (pointer.schema !== 1 || typeof pointer.releaseId !== "string" || !RELEASE_ID.test(pointer.releaseId)) throw new ReleaseChannelError("latest.json is not a schema 1 pointer.");
  const releaseBytes = await fetchCapped(childUrl(base, pointer.release, "release"), LIMITS.release, env);
  const signature = (await fetchCapped(childUrl(base, pointer.signature, "signature"), LIMITS.signature, env)).toString("utf8");
  if (!verifyBlobSignature(releaseBytes, signature, publicKey.key)) throw new ReleaseChannelError("release.json's signature does not verify with the installed release key.");

  const verified = parseRelease(parseJson(releaseBytes, "release.json"), pointer.releaseId, publicKey.sha256);
  let changelog: string | null = null;
  if (verified.changelogFile) {
    const releaseUrl = new URL(childUrl(base, pointer.release, "release"));
    const folder = new URL(".", releaseUrl);
    const bytes = await fetchCapped(childUrl(folder, verified.changelogFile.file, "changelog"), LIMITS.changelog, env);
    if (createHash("sha256").update(bytes).digest("hex") !== verified.changelogFile.sha256) throw new ReleaseChannelError("The changelog does not match the signed release.");
    changelog = bytes.toString("utf8");
  }
  const { changelogFile: _ignored, ...rest } = verified;
  void _ignored;
  return { ...rest, changelog };
}

export async function checkForRelease(env: Env = process.env, fetchLatest = fetchLatestRelease): Promise<ChannelCheck> {
  const current = currentRelease(env);
  const configured = Boolean(env.POLYNOVEA_RELEASE_CHANNEL_URL?.trim());
  if (!configured) return { configured, current, latest: null, upgradeAvailable: false, error: null };
  try {
    const latest = await fetchLatest(env);
    const upgradeAvailable = Boolean(latest && current.version && compareVersions(latest.version, current.version) > 0);
    return { configured, current, latest, upgradeAvailable, error: null };
  } catch (error) {
    const message = error instanceof ReleaseChannelError ? error.message : "The release check failed.";
    if (!(error instanceof ReleaseChannelError)) console.error("[system/release] release check failed:", error instanceof Error ? error.name : "unknown");
    return { configured, current, latest: null, upgradeAvailable: false, error: message };
  }
}
