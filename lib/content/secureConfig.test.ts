import { createCipheriv, randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ciphertextKid, decryptConfig, encryptConfig, secureConfigKeyAvailable } from "@/lib/content/secureConfig";
import { resetKeyRingCache } from "@/lib/setup/keyRing";

const noKeyFile = mkdtempSync(path.join(os.tmpdir(), "polynovea-secure-"));
const entry = (kid: string) => `${kid}:${randomBytes(32).toString("base64")}`;

/** The pre-ring format, exactly as the old secureConfig.ts wrote it. */
function legacyEncrypt(value: unknown, key: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(key, "base64"), iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64");
}

afterEach(() => {
  resetKeyRingCache();
  vi.restoreAllMocks();
});

describe("secure config encryption", () => {
  it("writes pv2.<kid>. ciphertext under the ring's first key", () => {
    const env = { CMS_MASTER_KEY: `${entry("k2")},${entry("k1")}`, POLYNOVEA_CONFIG_DIR: noKeyFile };
    const value = { secret: "whsec_example", nested: [1, 2] };
    const encrypted = encryptConfig(value, env);
    expect(encrypted.startsWith("pv2.k2.")).toBe(true);
    expect(ciphertextKid(encrypted)).toBe("k2");
    expect(encrypted).not.toContain("whsec_example");
    expect(decryptConfig(encrypted, env)).toEqual(value);
    expect(encryptConfig(value, env)).not.toBe(encrypted);
  });

  it("decrypts under an older ring key after rotation, and refuses an unknown key ID", () => {
    const old = entry("old");
    const encrypted = encryptConfig({ value: "x" }, { CMS_MASTER_KEY: old, POLYNOVEA_CONFIG_DIR: noKeyFile });
    resetKeyRingCache();
    expect(decryptConfig(encrypted, { CMS_MASTER_KEY: `${entry("new")},${old}`, POLYNOVEA_CONFIG_DIR: noKeyFile })).toEqual({ value: "x" });
    resetKeyRingCache();
    expect(() => decryptConfig(encrypted, { CMS_MASTER_KEY: entry("new"), POLYNOVEA_CONFIG_DIR: noKeyFile })).toThrow(/not in the key ring/);
  });

  it("adding CMS_MASTER_KEY later: new values use it, legacy and pv2.legacy values stay readable", () => {
    const legacyKey = randomBytes(32).toString("base64");
    const before = { CMS_CONFIG_ENCRYPTION_KEY: legacyKey, POLYNOVEA_CONFIG_DIR: noKeyFile };
    const written = encryptConfig({ value: "pv2-legacy" }, before);
    const unprefixed = legacyEncrypt({ value: "unprefixed" }, legacyKey);
    resetKeyRingCache();
    const after = { ...before, CMS_MASTER_KEY: entry("k1") };
    expect(ciphertextKid(encryptConfig({ value: "new" }, after))).toBe("k1");
    expect(decryptConfig(written, after)).toEqual({ value: "pv2-legacy" });
    expect(decryptConfig(unprefixed, after)).toEqual({ value: "unprefixed" });
  });

  it("reads legacy CMS_CONFIG_ENCRYPTION_KEY ciphertext for one release", () => {
    const legacyKey = randomBytes(32).toString("base64");
    const legacy = legacyEncrypt({ value: "token" }, legacyKey);
    const env = { CMS_MASTER_KEY: entry("k1"), CMS_CONFIG_ENCRYPTION_KEY: legacyKey, POLYNOVEA_CONFIG_DIR: noKeyFile };
    expect(ciphertextKid(legacy)).toBeNull();
    expect(decryptConfig(legacy, env)).toEqual({ value: "token" });
    expect(() => decryptConfig(legacy, { CMS_MASTER_KEY: env.CMS_MASTER_KEY, POLYNOVEA_CONFIG_DIR: noKeyFile })).toThrow(/CMS_CONFIG_ENCRYPTION_KEY/);
  });

  it("binds ciphertext to its purpose: a config.enc-style key cannot open it, tampering fails", () => {
    const env = { CMS_MASTER_KEY: entry("k1"), POLYNOVEA_CONFIG_DIR: noKeyFile };
    const encrypted = encryptConfig({ value: "x" }, env);
    const body = Buffer.from(encrypted.slice("pv2.k1.".length), "base64");
    body[body.length - 1] ^= 1;
    expect(() => decryptConfig(`pv2.k1.${body.toString("base64")}`, env)).toThrow();
    // Re-labelling legacy ciphertext as pv2 does not make it readable.
    const legacyKey = randomBytes(32).toString("base64");
    expect(() => decryptConfig(`pv2.k1.${legacyEncrypt({ value: "x" }, legacyKey)}`, { ...env, CMS_CONFIG_ENCRYPTION_KEY: legacyKey })).toThrow();
  });

  it("legacy key only: pv2.legacy values every process with the same environment can read", () => {
    const legacyKey = randomBytes(32).toString("base64");
    // Two processes (say the app and the delivery worker on another host): same environment, no file.
    const appEnv = { CMS_CONFIG_ENCRYPTION_KEY: legacyKey, POLYNOVEA_CONFIG_DIR: mkdtempSync(path.join(os.tmpdir(), "polynovea-app-")) };
    const workerEnv = { CMS_CONFIG_ENCRYPTION_KEY: legacyKey, POLYNOVEA_CONFIG_DIR: mkdtempSync(path.join(os.tmpdir(), "polynovea-worker-")) };
    const encrypted = encryptConfig({ value: "x" }, appEnv);
    expect(ciphertextKid(encrypted)).toBe("legacy");
    resetKeyRingCache();
    expect(decryptConfig(encrypted, workerEnv)).toEqual({ value: "x" });
    // Old unprefixed values still read too.
    expect(decryptConfig(legacyEncrypt({ value: "old" }, legacyKey), workerEnv)).toEqual({ value: "old" });
    expect(secureConfigKeyAvailable(appEnv)).toBe(true);
    expect(secureConfigKeyAvailable({ POLYNOVEA_CONFIG_DIR: noKeyFile })).toBe(false);
    expect(() => encryptConfig({ value: "x" }, { POLYNOVEA_CONFIG_DIR: noKeyFile })).toThrow(/No master key/);
  });
});
