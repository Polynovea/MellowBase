import { randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A fake database: each test says what the installation check sees.
const db = vi.hoisted(() => ({
  reachable: true,
  hasTable: true,
  hasAdmins: false,
  installed: false,
  connects: 0,
  urls: [] as string[],
  ssl: [] as unknown[],
}));

const TEST_ROOT = vi.hoisted(() => ["-----BEGIN CERTIFICATE-----", "root", "-----END CERTIFICATE-----"].join("\n"));

vi.mock("@/lib/setup/database/caBundles.mjs", () => ({
  certificateAuthoritiesFor: (id: string | null) => (id === "aws-rds-global-1" ? [TEST_ROOT] : null),
}));

vi.mock("pg", () => {
  class Client {
    constructor(readonly config: { connectionString: string; ssl?: unknown }) {
      db.urls.push(config.connectionString);
      db.ssl.push(config.ssl);
    }
    async connect() {
      db.connects += 1;
      if (!db.reachable) throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    }
    async query(text: string) {
      if (text.includes("to_regclass")) return { rows: [{ has_table: db.hasTable, has_admin_table: true }], rowCount: 1 };
      if (text.includes("from public.admin_users")) return { rows: db.hasAdmins ? [{}] : [], rowCount: db.hasAdmins ? 1 : 0 };
      return { rows: [{ installed: db.installed }], rowCount: 1 };
    }
    async end() {}
  }
  return { default: { Client } };
});

const { assertMode, currentMode, markInstalled, ModeError, onModeChange, resetModeForTests, resolveMode, runtimeDatabaseUrl } = await import("@/lib/setup/mode");
const { encryptInstallConfig, generateSecret } = await import("@/lib/setup/configStore");
const { resetKeyRingCache } = await import("@/lib/setup/keyRing");

const emptyDir = () => mkdtempSync(path.join(os.tmpdir(), "polynovea-mode-"));
const envUrl = "postgresql://polynovea_app:pw@localhost:5432/cms";

beforeEach(() => {
  Object.assign(db, { reachable: true, hasTable: true, hasAdmins: false, installed: false, connects: 0, urls: [], ssl: [] });
  resetModeForTests();
  resetKeyRingCache();
});
afterEach(() => vi.useRealTimers());

describe("setup mode decision", () => {
  it("no database settings → setup, without touching a database", async () => {
    const state = await resolveMode({ POLYNOVEA_CONFIG_DIR: emptyDir() });
    expect(state).toMatchObject({ mode: "setup", databaseSource: null, databaseReady: false });
    expect(db.connects).toBe(0);
    expect(currentMode()).toBe("setup");
  });

  it("settings, database reachable, installation row → running", async () => {
    db.installed = true;
    expect(await resolveMode({ POLYNOVEA_CONFIG_DIR: emptyDir(), POLYNOVEA_DATABASE_URL: envUrl })).toMatchObject({ mode: "running", databaseSource: "env" });
  });

  it("settings, no row → setup that skips the database step", async () => {
    expect(await resolveMode({ POLYNOVEA_CONFIG_DIR: emptyDir(), DATABASE_URL: envUrl })).toMatchObject({ mode: "setup", databaseSource: "env", databaseReady: true });
  });

  it("database unreachable → unavailable, never setup", async () => {
    db.reachable = false;
    const state = await resolveMode({ POLYNOVEA_CONFIG_DIR: emptyDir(), POLYNOVEA_DATABASE_URL: envUrl });
    expect(state.mode).toBe("unavailable");
    expect(state.reason).toContain("ECONNREFUSED");
  });

  it("an upgraded install whose migrations have not run is unavailable, not setup", async () => {
    db.hasTable = false;
    db.hasAdmins = true;
    expect((await resolveMode({ POLYNOVEA_CONFIG_DIR: emptyDir(), POLYNOVEA_DATABASE_URL: envUrl })).mode).toBe("unavailable");
    resetModeForTests();
    db.hasAdmins = false;
    expect(await resolveMode({ POLYNOVEA_CONFIG_DIR: emptyDir(), POLYNOVEA_DATABASE_URL: envUrl })).toMatchObject({ mode: "setup", databaseReady: false });
  });

  it("uses config.enc (the app role) before the environment", async () => {
    const dir = emptyDir();
    const env = { POLYNOVEA_CONFIG_DIR: dir, CMS_MASTER_KEY: `k1:${randomBytes(32).toString("base64")}`, POLYNOVEA_DATABASE_URL: envUrl };
    const config = {
      v: 1 as const,
      databaseMode: "local" as const,
      database: { host: "127.0.0.1", port: 5433, name: "polynovea", caBundleId: null },
      roles: { owner: { user: "polynovea_owner", password: generateSecret() }, app: { user: "polynovea_app", password: generateSecret() } },
      authSecret: generateSecret(),
      backupRepoPassword: generateSecret(),
    };
    writeFileSync(path.join(dir, "config.enc"), encryptInstallConfig(config, env), { mode: 0o600 });
    db.installed = true;
    expect(await resolveMode(env)).toMatchObject({ mode: "running", databaseSource: "config" });
    expect(new URL(db.urls[0]).port).toBe("5433");
    expect(runtimeDatabaseUrl(env)).toContain("127.0.0.1:5433");
  });

  it("an unreadable config.enc → unavailable, never setup", async () => {
    const dir = emptyDir();
    writeFileSync(path.join(dir, "config.enc"), JSON.stringify({ v: 1, kid: "gone", iv: "AAAAAAAAAAAAAAAA", tag: "AAAAAAAAAAAAAAAAAAAAAA==", ct: "AA==" }), { mode: 0o600 });
    const state = await resolveMode({ POLYNOVEA_CONFIG_DIR: dir, CMS_MASTER_KEY: `k1:${randomBytes(32).toString("base64")}` });
    expect(state).toMatchObject({ mode: "unavailable", databaseSource: "config" });
    expect(db.connects).toBe(0);
  });
});

describe("TLS from config.enc", () => {
  const writeConfig = (caBundleId: string | null, host = "cms.abc123.eu-west-1.rds.amazonaws.com") => {
    const dir = emptyDir();
    const env = { POLYNOVEA_CONFIG_DIR: dir, CMS_MASTER_KEY: `k1:${randomBytes(32).toString("base64")}`, DATABASE_CA_CERT: "ignored" };
    const config = {
      v: 1 as const,
      databaseMode: "managed" as const,
      database: { host, port: 5432, name: "polynovea", caBundleId },
      roles: { owner: { user: "polynovea_owner", password: generateSecret() }, app: { user: "polynovea_app", password: generateSecret() } },
      authSecret: generateSecret(),
      backupRepoPassword: null,
    };
    writeFileSync(path.join(dir, "config.enc"), encryptInstallConfig(config, env), { mode: 0o600 });
    return env;
  };

  it("trusts exactly the wizard's CA bundle, with the endpoint name for verification", async () => {
    db.installed = true;
    expect((await resolveMode(writeConfig("aws-rds-global-1"))).mode).toBe("running");
    expect(db.ssl[0]).toEqual({ rejectUnauthorized: true, ca: [TEST_ROOT], minVersion: "TLSv1.2", servername: "cms.abc123.eu-west-1.rds.amazonaws.com" });
  });

  it("an unknown CA bundle makes the CMS unavailable instead of falling back to weaker trust", async () => {
    const state = await resolveMode(writeConfig("retired-bundle-9"));
    expect(state.mode).toBe("unavailable");
    expect(db.connects).toBe(0);
  });

  it("a remote database with no CA bundle ID is refused, not verified against the system roots", async () => {
    expect((await resolveMode(writeConfig(null))).mode).toBe("unavailable");
    expect(db.connects).toBe(0);
  });

  it("verifies the endpoint name, and leaves the name check off only for a literal IP (bracketed IPv6 too)", async () => {
    const { tlsConnectionFor } = await import("@/lib/setup/installConnection.mjs");
    const named = tlsConnectionFor("postgresql://a:b@db.example.com:5432/x", { host: "db.example.com", caBundleId: "aws-rds-global-1" }, {});
    expect(named.ssl).toMatchObject({ servername: "db.example.com", ca: [TEST_ROOT] });
    const ipv6 = tlsConnectionFor("postgresql://a:b@[2001:db8::1]:5432/x", { host: "[2001:db8::1]", caBundleId: "aws-rds-global-1" }, {});
    expect(ipv6.ssl).not.toHaveProperty("servername");
    expect(() => tlsConnectionFor("postgresql://a:b@db.example.com/x", { host: "db.example.com", caBundleId: null }, {})).toThrow(/no CA bundle/);
  });

  it("the bundled database on loopback connects without TLS", async () => {
    db.installed = true;
    expect((await resolveMode(writeConfig(null, "127.0.0.1"))).mode).toBe("running");
    expect(db.ssl[0]).toBe(false);
  });
});

describe("mode cache", () => {
  it("shares one check between concurrent callers and caches running for good", async () => {
    db.installed = true;
    const env = { POLYNOVEA_CONFIG_DIR: emptyDir(), POLYNOVEA_DATABASE_URL: envUrl };
    await Promise.all([resolveMode(env), resolveMode(env), resolveMode(env)]);
    expect(db.connects).toBe(1);
    db.reachable = false;
    expect((await resolveMode(env)).mode).toBe("running");
    expect(db.connects).toBe(1);
  });

  it("re-checks unavailable, so a database that comes back is picked up without a restart", async () => {
    vi.useFakeTimers();
    const env = { POLYNOVEA_CONFIG_DIR: emptyDir(), POLYNOVEA_DATABASE_URL: envUrl };
    db.reachable = false;
    expect((await resolveMode(env)).mode).toBe("unavailable");
    db.reachable = true;
    db.installed = true;
    expect((await resolveMode(env)).mode).toBe("unavailable");
    vi.advanceTimersByTime(6_000);
    expect((await resolveMode(env)).mode).toBe("running");
  });

  it("markInstalled() switches setup to running without a restart and tells listeners", async () => {
    const env = { POLYNOVEA_CONFIG_DIR: emptyDir(), POLYNOVEA_DATABASE_URL: envUrl };
    expect((await resolveMode(env)).mode).toBe("setup");
    const seen: string[] = [];
    onModeChange((state) => seen.push(state.mode));
    markInstalled();
    expect(currentMode()).toBe("running");
    expect((await resolveMode(env)).mode).toBe("running");
    expect(seen).toEqual(["running"]);
  });
});

describe("assertMode", () => {
  it("passes in an expected mode and answers 404 for setup routes on a finished install", async () => {
    resetModeForTests();
    markInstalled();
    await expect(assertMode(["running"])).resolves.toMatchObject({ mode: "running" });
    const error = await assertMode("setup").catch((caught) => caught);
    expect(error).toBeInstanceOf(ModeError);
    expect(error.status).toBe(404);
    expect(error.toResponse().status).toBe(404);
  });

  it("answers 503 for normal routes during setup", async () => {
    await resolveMode({ POLYNOVEA_CONFIG_DIR: emptyDir() });
    const error = await assertMode("running").catch((caught) => caught);
    expect(error).toBeInstanceOf(ModeError);
    expect(error.status).toBe(503);
    expect(await error.toResponse().json()).toMatchObject({ setup: "/setup" });
  });
});
