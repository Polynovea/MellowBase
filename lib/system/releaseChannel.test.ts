import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const files = new Map<string, { body: string | Buffer; status?: number; headers?: Record<string, string> }>();
const requested: string[] = [];
vi.mock("@/lib/infrastructure/networkSafety", () => ({
  safeFetch: vi.fn(async (url: string, kind: string) => {
    requested.push(`${kind} ${url}`);
    if (!url.startsWith("https://") && kind !== "local") throw new Error("Connection URL must use HTTPS");
    const file = files.get(url);
    if (!file) return new Response("missing", { status: 404 });
    return new Response(typeof file.body === "string" ? file.body : new Uint8Array(file.body), { status: file.status ?? 200, headers: file.headers });
  }),
}));

const { checkForRelease, compareVersions, currentRelease, fetchLatestRelease, loadReleasePublicKey, verifyBlobSignature, LIMITS } = await import("./releaseChannel");

const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const pem = publicKey.export({ type: "spki", format: "pem" }).toString();
const pemSha = createHash("sha256").update(pem).digest("hex");
const other = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
// What `cosign sign-blob --output-signature` writes: base64 of the DER ECDSA signature over SHA-256.
const cosignSign = (bytes: Buffer, key = privateKey) => sign("sha256", bytes, key).toString("base64");
const BASE = "https://releases.example.com/polynovea";
const env = { POLYNOVEA_RELEASE_CHANNEL_URL: BASE, POLYNOVEA_RELEASE_PUBKEY_FILE: "/k.pub", POLYNOVEA_RELEASE_ID: "0.4.0+aaaaaaa" };
const readKey = () => loadReleasePublicKey(env, () => pem);

function publish(release: Record<string, unknown>, options: { signWith?: typeof privateKey; tamper?: boolean; changelog?: string } = {}) {
  const bytes = Buffer.from(`${JSON.stringify(release, null, 2)}\n`);
  files.set(`${BASE}/latest.json`, { body: JSON.stringify({ schema: 1, releaseId: release.releaseId, release: "0.4.1/release.json", signature: "0.4.1/release.json.sig" }) });
  const served = Buffer.from(bytes);
  if (options.tamper) served[served.length - 3] ^= 1;
  files.set(`${BASE}/0.4.1/release.json`, { body: served });
  files.set(`${BASE}/0.4.1/release.json.sig`, { body: `${cosignSign(bytes, options.signWith)}\n` });
  if (options.changelog !== undefined) files.set(`${BASE}/0.4.1/CHANGELOG.md`, { body: options.changelog });
}

const release = (extra: Record<string, unknown> = {}) => ({
  schema: 1,
  releaseId: "0.4.1+bbbbbbb",
  version: "0.4.1",
  image: "ghcr.io/polynovea/cms",
  digest: `sha256:${"a".repeat(64)}`,
  publicKeySha256: pemSha,
  createdAt: "2026-11-24T00:00:00Z",
  ...extra,
});

beforeEach(() => {
  files.clear();
  requested.length = 0;
});

describe("compareVersions", () => {
  it("orders releases and pre-releases by semantic version", () => {
    expect(compareVersions("0.4.1", "0.4.0")).toBe(1);
    expect(compareVersions("0.4.0", "0.10.0")).toBe(-1);
    expect(compareVersions("1.0.0-rc.1", "1.0.0")).toBe(-1);
    expect(compareVersions("1.0.0-rc.2", "1.0.0-rc.10")).toBe(-1);
    expect(compareVersions("1.0.0+abc", "1.0.0+def")).toBe(0);
    expect(() => compareVersions("latest", "1.0.0")).toThrow();
  });
  it("reads the running release from POLYNOVEA_RELEASE_ID", () => {
    expect(currentRelease({ POLYNOVEA_RELEASE_ID: "0.4.0+abc1234" })).toEqual({ releaseId: "0.4.0+abc1234", version: "0.4.0" });
    expect(currentRelease({})).toEqual({ releaseId: null, version: null });
    expect(currentRelease({ POLYNOVEA_RELEASE_ID: "../x" })).toEqual({ releaseId: null, version: null });
  });
});

describe("verifyBlobSignature (cosign sign-blob format)", () => {
  const blob = Buffer.from('{"schema":1}\n');
  it("accepts a base64 DER signature with a trailing newline", () => {
    expect(verifyBlobSignature(blob, `${cosignSign(blob)}\n`, publicKey)).toBe(true);
  });
  it("refuses one changed byte, another key, and non-DER or non-base64 text", () => {
    const tampered = Buffer.from(blob);
    tampered[2] ^= 1;
    expect(verifyBlobSignature(tampered, cosignSign(blob), publicKey)).toBe(false);
    expect(verifyBlobSignature(blob, cosignSign(blob, other.privateKey), publicKey)).toBe(false);
    const raw = sign("sha256", blob, { key: privateKey, dsaEncoding: "ieee-p1363" }).toString("base64");
    expect(verifyBlobSignature(blob, raw, publicKey)).toBe(false);
    expect(verifyBlobSignature(blob, "not base64!", publicKey)).toBe(false);
    expect(verifyBlobSignature(blob, "", publicKey)).toBe(false);
  });
});

describe("fetchLatestRelease", () => {
  it("returns a release only after its signature verifies, with the signed changelog", async () => {
    const changelog = "## 0.4.1\n- Fixes <script>alert(1)</script> nothing; shown as text.\n";
    publish(release({ rollback: "compatible", changelog: { file: "CHANGELOG.md", sha256: createHash("sha256").update(changelog).digest("hex") } }), { changelog });
    const latest = await fetchLatestRelease(env, readKey);
    expect(latest).toMatchObject({ releaseId: "0.4.1+bbbbbbb", version: "0.4.1", rollback: "compatible", changelog });
    expect(requested.every((line) => line.startsWith("production https://"))).toBe(true);
  });

  it("treats a missing or unknown rollback field as needing a restore", async () => {
    publish(release());
    expect((await fetchLatestRelease(env, readKey))?.rollback).toBe("restore");
    publish(release({ rollback: "yes" }));
    expect((await fetchLatestRelease(env, readKey))?.rollback).toBe("restore");
  });

  it("refuses a tampered release.json, another key's signature, or a different key hash", async () => {
    publish(release(), { tamper: true });
    await expect(fetchLatestRelease(env, readKey)).rejects.toThrow(/signature does not verify/);
    publish(release(), { signWith: other.privateKey });
    await expect(fetchLatestRelease(env, readKey)).rejects.toThrow(/signature does not verify/);
    publish(release({ publicKeySha256: "0".repeat(64) }));
    await expect(fetchLatestRelease(env, readKey)).rejects.toThrow(/different release key/);
  });

  it("refuses a changelog that does not match its signed hash", async () => {
    publish(release({ changelog: { file: "CHANGELOG.md", sha256: "0".repeat(64) } }), { changelog: "edited" });
    await expect(fetchLatestRelease(env, readKey)).rejects.toThrow(/changelog does not match/);
  });

  it("refuses pointer paths that leave the channel and a mismatched release id", async () => {
    publish(release());
    files.set(`${BASE}/latest.json`, { body: JSON.stringify({ schema: 1, releaseId: "0.4.1+bbbbbbb", release: "../evil/release.json", signature: "0.4.1/release.json.sig" }) });
    await expect(fetchLatestRelease(env, readKey)).rejects.toThrow(/invalid release path/);
    files.set(`${BASE}/latest.json`, { body: JSON.stringify({ schema: 1, releaseId: "0.4.1+bbbbbbb", release: "https://evil.example/r.json", signature: "x.sig" }) });
    await expect(fetchLatestRelease(env, readKey)).rejects.toThrow(/invalid release path/);
    publish(release());
    files.set(`${BASE}/latest.json`, { body: JSON.stringify({ schema: 1, releaseId: "9.9.9+ccccccc", release: "0.4.1/release.json", signature: "0.4.1/release.json.sig" }) });
    await expect(fetchLatestRelease(env, readKey)).rejects.toThrow(/does not match latest.json/);
  });

  it("caps sizes, by header and by streamed bytes", async () => {
    publish(release());
    files.set(`${BASE}/latest.json`, { body: "x".repeat(LIMITS.pointer + 1) });
    await expect(fetchLatestRelease(env, readKey)).rejects.toThrow(/larger than allowed/);
    publish(release());
    files.set(`${BASE}/0.4.1/release.json.sig`, { body: "x", headers: { "content-length": String(LIMITS.signature + 1) } });
    await expect(fetchLatestRelease(env, readKey)).rejects.toThrow(/larger than allowed/);
  });

  it("refuses an http channel, credentials in the URL, and a missing key", async () => {
    await expect(fetchLatestRelease({ ...env, POLYNOVEA_RELEASE_CHANNEL_URL: "http://releases.example.com/p" }, readKey)).rejects.toThrow(/refused: Connection URL must use HTTPS/);
    await expect(fetchLatestRelease({ ...env, POLYNOVEA_RELEASE_CHANNEL_URL: "https://u:p@releases.example.com/p" }, readKey)).rejects.toThrow(/credentials/);
    await expect(fetchLatestRelease(env, () => null)).rejects.toThrow(/No release public key/);
  });
});

describe("checkForRelease", () => {
  it("is off when no channel is configured", async () => {
    expect(await checkForRelease({})).toMatchObject({ configured: false, upgradeAvailable: false, error: null });
  });
  it("offers only a newer verified release", async () => {
    publish(release());
    const result = await checkForRelease(env, (e) => fetchLatestRelease(e, readKey));
    expect(result).toMatchObject({ upgradeAvailable: true, error: null, current: { version: "0.4.0" } });
    const same = await checkForRelease({ ...env, POLYNOVEA_RELEASE_ID: "0.4.1+bbbbbbb" }, (e) => fetchLatestRelease(e, readKey));
    expect(same.upgradeAvailable).toBe(false);
  });
  it("reports a plain error and shows nothing when verification fails", async () => {
    publish(release(), { tamper: true });
    const result = await checkForRelease(env, (e) => fetchLatestRelease(e, readKey));
    expect(result).toMatchObject({ latest: null, upgradeAvailable: false });
    expect(result.error).toMatch(/signature does not verify/);
  });
});
