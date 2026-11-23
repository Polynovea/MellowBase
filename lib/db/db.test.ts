import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { closePool, databaseUrlFromEnv, getPool, getSetupPool, PoolModeError, poolConfigFromEnv, postgresTimestampToIso } from "@/lib/db/pool";
import { markInstalled, resetModeForTests, resolveMode } from "@/lib/setup/mode";
import { expectOne, maybeOne, NotFoundError } from "@/lib/db/rows";
import { callFunction } from "@/lib/db/functions";
import { isClientSafeError } from "@/lib/http/clientError";

describe("pool configuration", () => {
  it("prefers the runtime role URL over DATABASE_URL", () => {
    expect(databaseUrlFromEnv({ POLYNOVEA_DATABASE_URL: "postgresql://app@db.example.com/x", DATABASE_URL: "postgresql://owner@db.example.com/x" }))
      .toBe("postgresql://app@db.example.com/x");
    expect(databaseUrlFromEnv({ DATABASE_URL: "postgresql://owner@db.example.com/x" })).toBe("postgresql://owner@db.example.com/x");
    expect(() => databaseUrlFromEnv({})).toThrow(/not configured/);
  });

  it("uses verify-full TLS for remote hosts, small pool and timeouts", () => {
    const config = poolConfigFromEnv({ POLYNOVEA_DATABASE_URL: "postgresql://app:pw@db.example.com:5432/cms?sslmode=require" });
    expect(config.ssl).toEqual({ rejectUnauthorized: true });
    expect(config.connectionString).not.toContain("sslmode");
    expect(config.max).toBe(10);
    expect(config.connectionTimeoutMillis).toBe(5_000);
    expect(config.idleTimeoutMillis).toBe(30_000);
    expect(config.statement_timeout).toBe(15_000);
    expect(config.idle_in_transaction_session_timeout).toBe(30_000);
    expect(config.options).toContain("TimeZone=UTC");
  });

  it("rejects invalid numeric settings", () => {
    expect(() => poolConfigFromEnv({ POLYNOVEA_DATABASE_URL: "postgresql://a@localhost/x", POLYNOVEA_DB_POOL_MAX: "0" })).toThrow(/positive integer/);
  });

  it("formats timestamps the way PostgREST returned them", () => {
    expect(postgresTimestampToIso("2026-11-22 18:37:00.123456+00")).toBe("2026-11-22T18:37:00.123456+00:00");
    expect(postgresTimestampToIso("2026-11-22 18:37:00+05:30")).toBe("2026-11-22T18:37:00+05:30");
    expect(postgresTimestampToIso("2026-11-22 18:37:00")).toBe("2026-11-22T18:37:00");
  });
});

describe("row helpers", () => {
  it("expectOne behaves like .single()", () => {
    expect(expectOne([1], "x")).toBe(1);
    expect(() => expectOne([], "Could not update taxonomy")).toThrow(NotFoundError);
    expect(() => expectOne([1, 2], "x")).toThrow("x");
  });

  it("maybeOne behaves like .maybeSingle()", () => {
    expect(maybeOne([])).toBeNull();
    expect(maybeOne([1])).toBe(1);
    expect(() => maybeOne([1, 2])).toThrow();
  });

  it("not-found messages are safe for API callers", () => {
    expect(isClientSafeError(new NotFoundError("Could not update taxonomy"))).toBe(true);
  });
});

describe("callFunction validation", () => {
  it("refuses unknown functions and arguments before touching the database", async () => {
    await expect(callFunction("not_a_function" as never, {} as never)).rejects.toThrow(/Unknown SQL function/);
    await expect(
      callFunction("cms_merge_taxonomy_terms", { p_workspace_id: "a", "x; drop table y": "b" } as never),
    ).rejects.toThrow(/Unknown argument/);
  });
});

describe("pool and setup mode (second enforcement layer)", () => {
  const noConfig = { POLYNOVEA_CONFIG_DIR: mkdtempSync(path.join(os.tmpdir(), "polynovea-pool-")) };

  afterEach(async () => {
    await closePool();
    resetModeForTests();
    vi.unstubAllEnvs();
  });

  it("refuses to open the runtime pool in setup mode; the wizard gets its own pool", async () => {
    vi.stubEnv("POLYNOVEA_CONFIG_DIR", noConfig.POLYNOVEA_CONFIG_DIR);
    expect((await resolveMode(noConfig)).mode).toBe("setup");
    expect(() => getPool()).toThrow(PoolModeError);
    vi.stubEnv("POLYNOVEA_DATABASE_URL", "postgresql://app@localhost:5432/cms");
    expect(getSetupPool()).toBe(getSetupPool());
  });

  it("refuses the setup pool once installed", () => {
    vi.stubEnv("POLYNOVEA_CONFIG_DIR", noConfig.POLYNOVEA_CONFIG_DIR);
    vi.stubEnv("POLYNOVEA_DATABASE_URL", "postgresql://app@localhost:5432/cms");
    markInstalled();
    expect(() => getSetupPool()).toThrow(PoolModeError);
    expect(getPool()).toBe(getPool());
  });

  it("a pool opened before the mode was known still refuses connections in setup mode", async () => {
    vi.stubEnv("POLYNOVEA_CONFIG_DIR", noConfig.POLYNOVEA_CONFIG_DIR);
    vi.stubEnv("POLYNOVEA_DATABASE_URL", "postgresql://app@localhost:5432/cms");
    const pool = getPool();
    await resolveMode(noConfig);
    expect(() => pool.connect()).toThrow(PoolModeError);
    await expect(Promise.resolve().then(() => pool.query("select 1"))).rejects.toThrow(PoolModeError);
  });
});
