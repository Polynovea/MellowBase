import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { deriveKey, formatMasterKeyRing, loadKeyRing, masterKeyForOwner, masterKeyPath, parseMasterKeyRing, purposeKeys, requireKeyRing, resetKeyRingCache } from "@/lib/setup/keyRing";

const tempDir = () => mkdtempSync(path.join(os.tmpdir(), "polynovea-keyring-"));
const entry = (kid: string) => `${kid}:${randomBytes(32).toString("base64")}`;

afterEach(() => resetKeyRingCache());

describe("master key ring", () => {
  it("parses kid:base64 lists; the first key is primary", () => {
    const keys = parseMasterKeyRing(` ${entry("k2")} , ${entry("k1")}`);
    expect(keys.map((key) => key.kid)).toEqual(["k2", "k1"]);
    expect(keys.every((key) => key.key.length === 32)).toBe(true);
    expect(parseMasterKeyRing(formatMasterKeyRing(keys)).map((key) => key.key.toString("hex"))).toEqual(keys.map((key) => key.key.toString("hex")));
  });

  it("refuses malformed rings without echoing key material", () => {
    const short = `k1:${randomBytes(16).toString("base64")}`;
    expect(() => parseMasterKeyRing("")).toThrow(/empty/);
    expect(() => parseMasterKeyRing(randomBytes(32).toString("base64"))).toThrow(/kid:base64/);
    expect(() => parseMasterKeyRing(short)).toThrow(/exactly 32 bytes/);
    expect(() => parseMasterKeyRing(`bad.kid:${randomBytes(32).toString("base64")}`)).toThrow(/key IDs/);
    expect(() => parseMasterKeyRing(`${entry("k1")},${entry("k1")}`)).toThrow(/twice/);
    try {
      parseMasterKeyRing(short);
    } catch (error) {
      expect((error as Error).message).not.toContain(short.split(":")[1]);
    }
  });

  it("prefers CMS_MASTER_KEY over master.key", () => {
    const dir = tempDir();
    const ring = loadKeyRing({ CMS_MASTER_KEY: entry("env1"), POLYNOVEA_CONFIG_DIR: dir }, { generate: true });
    expect(ring?.source).toBe("env");
    expect(ring?.keys[0].kid).toBe("env1");
    expect(() => statSync(path.join(dir, "master.key"))).toThrow();
  });

  it("returns null without a key, and generates master.key on first boot", () => {
    const env = { POLYNOVEA_CONFIG_DIR: path.join(tempDir(), "nested") };
    expect(loadKeyRing(env)).toBeNull();
    expect(() => requireKeyRing(env)).toThrow(/No master key/);
    const ring = loadKeyRing(env, { generate: true });
    expect(ring?.source).toBe("file");
    expect(ring?.keys).toHaveLength(1);
    const file = masterKeyPath(env);
    expect(readFileSync(file, "utf8").trim()).toBe(formatMasterKeyRing(ring!.keys));
    if (process.platform !== "win32") {
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
    }
    // A second boot reads the same key instead of making a new one.
    resetKeyRingCache();
    expect(loadKeyRing(env, { generate: true })?.keys[0].key.equals(ring!.keys[0].key)).toBe(true);
    expect(masterKeyForOwner(env)).toBe(formatMasterKeyRing([ring!.keys[0]]));
    expect(masterKeyForOwner({ CMS_MASTER_KEY: entry("ops") })).toBeNull();
  });

  it.skipIf(process.platform === "win32")("refuses a master.key that other users can read", () => {
    const dir = tempDir();
    const file = path.join(dir, "master.key");
    writeFileSync(file, entry("k1"), { mode: 0o644 });
    expect(() => loadKeyRing({ POLYNOVEA_CONFIG_DIR: dir })).toThrow(/chmod 600/);
  });

  it("legacy key only: the ring is that key under the `legacy` ID, and no file is ever created", () => {
    const dir = path.join(tempDir(), "config");
    const legacy = randomBytes(32).toString("base64");
    const ring = loadKeyRing({ CMS_CONFIG_ENCRYPTION_KEY: legacy, POLYNOVEA_CONFIG_DIR: dir }, { generate: true });
    expect(ring).toMatchObject({ source: "legacy", keys: [{ kid: "legacy" }] });
    expect(ring!.keys[0].key.equals(Buffer.from(legacy, "base64"))).toBe(true);
    expect(() => statSync(dir)).toThrow();
    expect(masterKeyForOwner({ CMS_CONFIG_ENCRYPTION_KEY: legacy, POLYNOVEA_CONFIG_DIR: dir })).toBeNull();
    resetKeyRingCache();
    expect(() => loadKeyRing({ CMS_CONFIG_ENCRYPTION_KEY: randomBytes(16).toString("base64"), POLYNOVEA_CONFIG_DIR: dir })).toThrow(/32-byte/);
  });

  it("both keys set: CMS_MASTER_KEY is primary and the legacy key is appended for reading", () => {
    const legacy = randomBytes(32).toString("base64");
    const ring = requireKeyRing({ CMS_MASTER_KEY: entry("k1"), CMS_CONFIG_ENCRYPTION_KEY: legacy });
    expect(ring.keys.map((key) => key.kid)).toEqual(["k1", "legacy"]);
    resetKeyRingCache();
    // An operator who lists `legacy` explicitly keeps exactly their ring.
    const explicit = `k2:${randomBytes(32).toString("base64")},legacy:${randomBytes(32).toString("base64")}`;
    expect(requireKeyRing({ CMS_MASTER_KEY: explicit, CMS_CONFIG_ENCRYPTION_KEY: legacy }).keys.map((key) => key.kid)).toEqual(["k2", "legacy"]);
  });

  it("derives a different key per purpose and never returns the master key itself", () => {
    const [master] = parseMasterKeyRing(entry("k1"));
    const derived = (["config", "secure-config", "storage-signing"] as const).map((purpose) => deriveKey(master, purpose));
    expect(new Set(derived.map((key) => key.toString("hex"))).size).toBe(3);
    expect(derived.some((key) => key.equals(master.key))).toBe(false);
    expect(deriveKey(master, "config").equals(deriveKey(master, "config"))).toBe(true);
  });

  it("looks derived keys up by key ID for decryption", () => {
    const ring = requireKeyRing({ CMS_MASTER_KEY: `${entry("new")},${entry("old")}` });
    const keys = purposeKeys(ring, "config");
    expect(keys.primary.kid).toBe("new");
    expect(keys.byKid("old")?.equals(keys.all[1].key)).toBe(true);
    expect(keys.byKid("missing")).toBeUndefined();
  });
});
