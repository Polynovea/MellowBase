import { describe, expect, it } from "vitest";
import { databaseUrlFromEnv, poolConfigFromEnv, postgresTimestampToIso } from "@/lib/db/pool";
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
