import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cmsBaseUrl, mediaLinkUrl, signedReadUrl, signedUploadUrl, signStorageToken, storageSigningKeys, verifyStorageToken } from "@/lib/media/signedStorageUrls";

const keyA = randomBytes(32).toString("base64");
const keyB = randomBytes(32).toString("base64");
const env = { POLYNOVEA_STORAGE_SIGNING_KEY: keyA };
const ws = "11111111-1111-4111-8111-111111111111";
const write = { o: "write" as const, p: "connection:abc", w: ws, k: `${ws}/general/1-x.png`, t: "image/png", n: 1234 };

afterEach(() => vi.useRealTimers());

describe("storage URL signing", () => {
  it("round-trips a write token with every bound field", () => {
    const token = signStorageToken(write, 900, env);
    const verified = verifyStorageToken(token, "write", env);
    expect(verified.ok).toBe(true);
    if (verified.ok) expect(verified.payload).toMatchObject({ v: 1, ...write });
  });

  it("refuses a token whose payload was changed (size, key, type or workspace)", () => {
    const token = signStorageToken(write, 900, env);
    const [, signature] = token.split(".");
    for (const change of [{ n: 999999999 }, { k: `${ws}/general/other.png` }, { t: "text/html" }, { w: "22222222-2222-4222-8222-222222222222" }]) {
      const forged = Buffer.from(JSON.stringify({ v: 1, ...write, ...change, e: Math.floor(Date.now() / 1000) + 900 })).toString("base64url");
      expect(verifyStorageToken(`${forged}.${signature}`, "write", env)).toEqual({ ok: false, reason: "signature" });
    }
  });

  it("refuses a token signed with another key, and a altered signature", () => {
    const token = signStorageToken(write, 900, { POLYNOVEA_STORAGE_SIGNING_KEY: keyB });
    expect(verifyStorageToken(token, "write", env)).toEqual({ ok: false, reason: "signature" });
    const own = signStorageToken(write, 900, env);
    const [body, signature] = own.split(".");
    const altered = Buffer.from(signature, "base64url");
    altered[0] ^= 1;
    expect(verifyStorageToken(`${body}.${altered.toString("base64url")}`, "write", env)).toEqual({ ok: false, reason: "signature" });
  });

  it("expires", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-23T10:00:00Z"));
    const token = signStorageToken(write, 900, env);
    vi.setSystemTime(new Date("2026-11-23T10:14:59Z"));
    expect(verifyStorageToken(token, "write", env).ok).toBe(true);
    vi.setSystemTime(new Date("2026-11-23T10:15:00Z"));
    expect(verifyStorageToken(token, "write", env)).toEqual({ ok: false, reason: "expired" });
  });

  it("binds the operation: a read token cannot upload and a write token cannot read", () => {
    const read = signStorageToken({ o: "read", p: "local", k: write.k }, 3600, env);
    expect(verifyStorageToken(read, "write", env)).toEqual({ ok: false, reason: "operation" });
    expect(verifyStorageToken(signStorageToken(write, 900, env), "read", env)).toEqual({ ok: false, reason: "operation" });
  });

  it("rejects malformed input without throwing", () => {
    for (const bad of [undefined, 42, "", "abc", "a.b.c", "x".repeat(5000), "e30.!!!", `${Buffer.from("not json").toString("base64url")}.${"A".repeat(43)}`]) {
      expect(verifyStorageToken(bad, "read", env).ok).toBe(false);
    }
  });

  it("caps the lifetime a token can be minted with", () => {
    expect(() => signStorageToken(write, 0, env)).toThrow();
    expect(() => signStorageToken(write, 25 * 3600, env)).toThrow();
  });

  it("verifies with every key in the ring and signs with the first (rotation)", () => {
    const old = signStorageToken(write, 900, { POLYNOVEA_STORAGE_SIGNING_KEY: keyA });
    const ring = { POLYNOVEA_STORAGE_SIGNING_KEY: `${keyB},${keyA}` };
    expect(verifyStorageToken(old, "write", ring).ok).toBe(true);
    const fresh = signStorageToken(write, 900, ring);
    expect(verifyStorageToken(fresh, "write", { POLYNOVEA_STORAGE_SIGNING_KEY: keyB }).ok).toBe(true);
    expect(verifyStorageToken(fresh, "write", { POLYNOVEA_STORAGE_SIGNING_KEY: keyA }).ok).toBe(false);
  });

  it("derives a separate key from CMS_CONFIG_ENCRYPTION_KEY when no signing key is set", () => {
    const master = randomBytes(32);
    const [derived] = storageSigningKeys({ CMS_CONFIG_ENCRYPTION_KEY: master.toString("base64") });
    expect(derived).toHaveLength(32);
    expect(derived.equals(master)).toBe(false);
    expect(() => storageSigningKeys({})).toThrow(/POLYNOVEA_STORAGE_SIGNING_KEY/);
    expect(() => storageSigningKeys({ POLYNOVEA_STORAGE_SIGNING_KEY: randomBytes(16).toString("base64") })).toThrow(/32/);
  });

  it("media links never expire, bind connection, workspace and key, and are their own operation", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-23T10:00:00Z"));
    const url = mediaLinkUrl({ providerKey: write.p, workspaceId: ws, key: write.k, servedFromDisk: true }, null, env);
    const token = url.split("/")[4];
    vi.setSystemTime(new Date("2036-11-23T10:00:00Z"));
    const verified = verifyStorageToken(token, "media", env);
    expect(verified).toEqual({ ok: true, payload: { v: 1, o: "media", p: write.p, w: ws, k: write.k, d: "local" } });
    expect(verifyStorageToken(token, "read", env)).toEqual({ ok: false, reason: "operation" });
    expect(verifyStorageToken(token, "write", env)).toEqual({ ok: false, reason: "operation" });
    const [, signature] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ v: 1, o: "media", p: write.p, w: ws, k: `${ws}/general/other.png`, d: "local" })).toString("base64url");
    expect(verifyStorageToken(`${forged}.${signature}`, "media", env)).toEqual({ ok: false, reason: "signature" });
  });

  it("an expiring read token cannot be passed off as a media link", () => {
    const read = signStorageToken({ o: "read", p: "local", k: write.k }, 3600, env);
    expect(verifyStorageToken(read, "media", env).ok).toBe(false);
  });

  it("resolves the CMS public URL from the connection override, then POLYNOVEA_PUBLIC_URL", () => {
    expect(cmsBaseUrl("https://override.example.com/cms/", { POLYNOVEA_PUBLIC_URL: "https://cms.example.com" })).toBe("https://override.example.com/cms");
    expect(cmsBaseUrl("", { POLYNOVEA_PUBLIC_URL: "https://cms.example.com/" })).toBe("https://cms.example.com");
    expect(cmsBaseUrl(null, {})).toBeNull();
    expect(() => cmsBaseUrl("javascript:alert(1)", {})).toThrow();
    expect(mediaLinkUrl({ providerKey: write.p, workspaceId: ws, key: write.k, servedFromDisk: false }, "https://cms.example.com", env)).toMatch(/^https:\/\/cms\.example\.com\/api\/storage\/media\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}\/1-x\.png$/);
  });

  it("builds read and upload URLs under the signed routes", () => {
    const read = signedReadUrl(write.k, "https://cms.example.com/", env);
    expect(read).toMatch(/^https:\/\/cms\.example\.com\/api\/storage\/files\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}\/1-x\.png$/);
    const upload = signedUploadUrl({ providerKey: write.p, workspaceId: ws, key: write.k, contentType: write.t, contentLength: write.n }, null, env);
    expect(upload).toMatch(/^\/api\/storage\/upload\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/);
    expect(() => signedUploadUrl({ providerKey: write.p, workspaceId: ws, key: write.k, contentType: write.t, contentLength: 0 }, null, env)).toThrow();
  });
});
