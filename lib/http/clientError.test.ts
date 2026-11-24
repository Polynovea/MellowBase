import { afterEach, describe, expect, it, vi } from "vitest";
import { clientErrorMessage, isClientSafeError } from "./clientError";

afterEach(() => vi.restoreAllMocks());

describe("clientErrorMessage", () => {
  it.each([
    new Error("Slug is already used by another entry"),
    Object.assign(new Error("Extension route is not declared"), { status: 403 }),
    Object.assign(new Error("Release cannot move from draft to published"), { status: 409 }),
  ])("passes through messages written for the caller: %s", (error) => {
    expect(isClientSafeError(error)).toBe(true);
    expect(clientErrorMessage(error, "fallback")).toBe(error.message);
  });

  it.each([
    ["a PostgREST result object", { message: 'relation "admin_users" does not exist', code: "42P01", details: null, hint: null }],
    ["a Postgres driver error", Object.assign(new Error("duplicate key value violates unique constraint \"assets_pkey\""), { code: "23505" })],
    ["a rethrown database message", new Error('column "secret" does not exist')],
    ["a network failure", Object.assign(new Error("getaddrinfo ENOTFOUND db.internal"), { errno: -3008, syscall: "getaddrinfo" })],
    ["a runtime bug", new TypeError("Cannot read properties of undefined (reading 'id')")],
    ["an AWS SDK error", Object.assign(new Error("Access Denied"), { $metadata: { httpStatusCode: 403 } })],
    ["a 4xx error carrying internals", Object.assign(new Error('permission denied for table workspaces'), { status: 403 })],
    ["a string", "boom"],
    ["nothing", undefined],
  ])("hides %s behind the fallback and a reference", (_label, error) => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const message = clientErrorMessage(error, "Could not load entries");
    expect(message).toMatch(/^Could not load entries \(ref [0-9a-f]{8}\)$/);
    expect(log).toHaveBeenCalledOnce();
    expect(log.mock.calls[0][2]).toBe(message.slice(-9, -1));
  });
});

describe("upgrade trial (read-only database login)", () => {
  it("tells the caller an upgrade is in progress instead of a reference-only error", async () => {
    const { clientErrorMessage, isUpgradeReadOnlyError, UPGRADE_IN_PROGRESS } = await import("./clientError");
    const error = Object.assign(new Error("cannot execute INSERT in a read-only transaction"), { code: "25006" });
    expect(isUpgradeReadOnlyError(error)).toBe(true);
    expect(clientErrorMessage(error, "Could not save")).toBe(UPGRADE_IN_PROGRESS);
    expect(clientErrorMessage(Object.assign(new Error("x"), { code: "23505" }), "Could not save")).toMatch(/^Could not save \(ref /);
  });
});
