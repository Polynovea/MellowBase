import { randomBytes } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { configPath, databaseUrlFromConfig, decryptInstallConfig, encryptInstallConfig, generateSecret, readConfig, validateInstallConfig, writeConfig, type InstallConfig } from "@/lib/setup/configStore";
import { resetKeyRingCache } from "@/lib/setup/keyRing";

const entry = (kid: string) => `${kid}:${randomBytes(32).toString("base64")}`;
const tempDir = () => mkdtempSync(path.join(os.tmpdir(), "polynovea-config-"));

const config = (): InstallConfig => ({
  v: 1,
  databaseMode: "managed",
  database: { host: "cms.abc123.eu-west-1.rds.amazonaws.com", port: 5432, name: "polynovea", caBundleId: "aws-rds-global" },
  roles: { owner: { user: "polynovea_owner", password: generateSecret() }, app: { user: "polynovea_app", password: generateSecret() } },
  authSecret: generateSecret(),
  backupRepoPassword: null,
});

afterEach(() => resetKeyRingCache());

describe("config.enc", () => {
  it("round-trips through the {v,kid,iv,tag,ct} envelope with no plaintext on disk", async () => {
    const env = { POLYNOVEA_CONFIG_DIR: tempDir(), CMS_MASTER_KEY: entry("k1") };
    const value = config();
    expect(await readConfig(env)).toBeNull();
    await writeConfig(value, env);
    const raw = readFileSync(configPath(env), "utf8");
    expect(Object.keys(JSON.parse(raw)).sort()).toEqual(["ct", "iv", "kid", "tag", "v"]);
    expect(JSON.parse(raw)).toMatchObject({ v: 1, kid: "k1" });
    for (const secret of [value.roles.owner.password, value.roles.app.password, value.authSecret, value.database.host]) expect(raw).not.toContain(secret);
    expect(await readConfig(env)).toEqual(value);
    if (process.platform !== "win32") expect(statSync(configPath(env)).mode & 0o777).toBe(0o600);
    // Atomic write leaves no temporary files behind.
    expect(readdirSync(env.POLYNOVEA_CONFIG_DIR).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("is bound to its purpose: tampering, a wrong key or a missing key ID fail", () => {
    const env = { CMS_MASTER_KEY: entry("k1"), POLYNOVEA_CONFIG_DIR: tempDir() };
    const text = encryptInstallConfig(config(), env);
    const envelope = JSON.parse(text);
    const flipped = Buffer.from(envelope.ct, "base64");
    flipped[0] ^= 1;
    expect(() => decryptInstallConfig(JSON.stringify({ ...envelope, ct: flipped.toString("base64") }), env)).toThrow(/could not be decrypted/);
    resetKeyRingCache();
    expect(() => decryptInstallConfig(text, { CMS_MASTER_KEY: entry("k1"), POLYNOVEA_CONFIG_DIR: env.POLYNOVEA_CONFIG_DIR })).toThrow(/could not be decrypted/);
    resetKeyRingCache();
    expect(() => decryptInstallConfig(text, { CMS_MASTER_KEY: entry("k2"), POLYNOVEA_CONFIG_DIR: env.POLYNOVEA_CONFIG_DIR })).toThrow(/not in the key ring/);
    expect(() => decryptInstallConfig("{}", env)).toThrow(/unknown format/);
  });

  it("decrypts with an older key after rotation and writes with the new first key", async () => {
    const dir = tempDir();
    const old = entry("old");
    await writeConfig(config(), { CMS_MASTER_KEY: old, POLYNOVEA_CONFIG_DIR: dir });
    resetKeyRingCache();
    const rotated = { CMS_MASTER_KEY: `${entry("new")},${old}`, POLYNOVEA_CONFIG_DIR: dir };
    const value = await readConfig(rotated);
    await writeConfig(value!, rotated);
    expect(JSON.parse(readFileSync(configPath(rotated), "utf8")).kid).toBe("new");
  });

  it("validates fields and never puts values in its errors", () => {
    const bad = { ...config(), roles: { owner: { user: "polynovea_owner", password: "short" }, app: config().roles.app } };
    expect(() => validateInstallConfig(bad)).toThrow(/roles\.owner\.password/);
    expect(() => validateInstallConfig({ ...config(), database: { ...config().database, port: 0 } })).toThrow(/database\.port/);
    expect(() => validateInstallConfig({ ...config(), database: { ...config().database, host: "db host; drop" } })).toThrow(/database\.host/);
    expect(() => validateInstallConfig({ ...config(), databaseMode: "other" })).toThrow(/databaseMode/);
    const same = config();
    same.roles.app.user = same.roles.owner.user;
    expect(() => validateInstallConfig(same)).toThrow(/different logins/);
    try {
      validateInstallConfig(bad);
    } catch (error) {
      expect((error as Error).message).not.toContain("short");
    }
  });

  it.skipIf(process.platform === "win32")("refuses a config.enc other users can read", async () => {
    const env = { POLYNOVEA_CONFIG_DIR: tempDir(), CMS_MASTER_KEY: entry("k1") };
    writeFileSync(configPath(env), encryptInstallConfig(config(), env), { mode: 0o644 });
    await expect(readConfig(env)).rejects.toThrow(/chmod 600/);
  });

  it("builds role URLs from the host name, never a pinned IP, with credentials encoded", () => {
    const value = config();
    value.roles.app.password = "p@ss/word:with#chars-1234";
    const url = new URL(databaseUrlFromConfig(value, "app"));
    expect(url.hostname).toBe(value.database.host);
    expect(url.port).toBe("5432");
    expect(url.pathname).toBe("/polynovea");
    expect(decodeURIComponent(url.username)).toBe("polynovea_app");
    expect(decodeURIComponent(url.password)).toBe("p@ss/word:with#chars-1234");
    expect(new URL(databaseUrlFromConfig({ ...value, database: { ...value.database, host: "::1" } }, "owner")).hostname).toBe("[::1]");
  });
});

describe("config.enc rotation through keys reencrypt", () => {
  it("rewrites config.enc only when it uses an older key", async () => {
    const { reencryptConfigFile } = await import("@/lib/setup/reencrypt");
    const dir = tempDir();
    const old = entry("old");
    expect(await reencryptConfigFile({ CMS_MASTER_KEY: old, POLYNOVEA_CONFIG_DIR: dir })).toBe("absent");
    await writeConfig(config(), { CMS_MASTER_KEY: old, POLYNOVEA_CONFIG_DIR: dir });
    expect(await reencryptConfigFile({ CMS_MASTER_KEY: old, POLYNOVEA_CONFIG_DIR: dir })).toBe("current");
    resetKeyRingCache();
    const rotated = { CMS_MASTER_KEY: `${entry("new")},${old}`, POLYNOVEA_CONFIG_DIR: dir };
    expect(await reencryptConfigFile(rotated, true)).toBe("would-rewrite");
    expect(await reencryptConfigFile(rotated)).toBe("rewritten");
    expect(JSON.parse(readFileSync(configPath(rotated), "utf8")).kid).toBe("new");
    expect(await reencryptConfigFile(rotated)).toBe("current");
  });
});

describe("readInstallConfigSync (plain-Node reader for scripts)", () => {
  it("returns null when config.enc is absent, and the config when it is valid", async () => {
    const { readInstallConfigSync } = await import("@/lib/setup/configStore.mjs");
    const env = { POLYNOVEA_CONFIG_DIR: tempDir(), CMS_MASTER_KEY: entry("k1") };
    expect(readInstallConfigSync(env)).toBeNull();
    const value = config();
    await writeConfig(value, env);
    expect(readInstallConfigSync(env)).toEqual(value);
  });

  it("refuses a wrong key or a tampered file without revealing values", async () => {
    const { readInstallConfigSync } = await import("@/lib/setup/configStore.mjs");
    const dir = tempDir();
    const value = config();
    await writeConfig(value, { POLYNOVEA_CONFIG_DIR: dir, CMS_MASTER_KEY: entry("k1") });
    resetKeyRingCache();
    const wrong = (() => {
      try {
        readInstallConfigSync({ POLYNOVEA_CONFIG_DIR: dir, CMS_MASTER_KEY: entry("k1") });
      } catch (error) {
        return error as Error;
      }
    })();
    expect(wrong?.message).toMatch(/could not be decrypted/);
    for (const secret of [value.roles.owner.password, value.authSecret, value.database.host]) expect(wrong?.message).not.toContain(secret);
    resetKeyRingCache();
    const env = { POLYNOVEA_CONFIG_DIR: dir, CMS_MASTER_KEY: entry("other") };
    expect(() => readInstallConfigSync(env)).toThrow(/not in the key ring/);
    const file = configPath(env);
    const envelope = JSON.parse(readFileSync(file, "utf8"));
    envelope.tag = Buffer.alloc(16).toString("base64");
    writeFileSync(file, JSON.stringify(envelope), { mode: 0o600 });
    resetKeyRingCache();
    expect(() => readInstallConfigSync({ POLYNOVEA_CONFIG_DIR: dir, CMS_MASTER_KEY: entry("k1") })).toThrow(/could not be decrypted|not in the key ring/);
  });

  it.skipIf(process.platform === "win32")("refuses a config.enc with loose permissions", async () => {
    const { readInstallConfigSync } = await import("@/lib/setup/configStore.mjs");
    const env = { POLYNOVEA_CONFIG_DIR: tempDir(), CMS_MASTER_KEY: entry("k1") };
    writeFileSync(configPath(env), encryptInstallConfig(config(), env), { mode: 0o640 });
    expect(() => readInstallConfigSync(env)).toThrow(/chmod 600/);
  });

  it("loads in plain Node without path aliases, as run-migrations.mjs will use it", async () => {
    const { execFileSync } = await import("node:child_process");
    const env = { POLYNOVEA_CONFIG_DIR: tempDir(), CMS_MASTER_KEY: entry("k1") };
    await writeConfig(config(), env);
    const script = 'const m = await import("./lib/setup/configStore.mjs"); const c = m.readInstallConfigSync(); console.log(c.database.name + " " + (m.configPath() === process.env.EXPECTED));';
    const out = execFileSync(process.execPath, ["--input-type=module", "-e", script], { env: { ...process.env, ...env, EXPECTED: configPath(env) }, encoding: "utf8" });
    expect(out.trim()).toBe("polynovea true");
  });
});
