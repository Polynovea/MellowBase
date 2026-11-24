import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelCheck } from "./releaseChannel";

const data = vi.hoisted(() => ({
  open: null as null | Record<string, unknown>,
  requested: [] as unknown[],
  recorded: [] as Array<Record<string, unknown>>,
}));
vi.mock("./systemData", () => ({
  openUpgrade: vi.fn(async () => data.open),
  requestUpgrade: vi.fn(async (input: unknown) => {
    data.requested.push(input);
    return "row-id";
  }),
  recordUpgradeProgress: vi.fn(async (input: Record<string, unknown>) => {
    data.recorded.push(input);
    return true;
  }),
}));

const { startUpgrade, ingestAgentStatus, parseAgentStatus, PICKUP_TIMEOUT_MS, RUNNING_TIMEOUT_MS } = await import("./upgradeRequest");

let root: string;
let env: Record<string, string>;
const check = (overrides: Partial<ChannelCheck["latest"] & object> = {}, extra: Partial<ChannelCheck> = {}) => async (): Promise<ChannelCheck> => ({
  configured: true,
  current: { releaseId: "0.4.0+aaaaaaa", version: "0.4.0" },
  latest: { releaseId: "0.4.1+bbbbbbb", version: "0.4.1", image: "r/cms", digest: `sha256:${"b".repeat(64)}`, rollback: "compatible", createdAt: null, changelog: null, ...overrides },
  upgradeAvailable: true,
  error: null,
  ...extra,
});

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "upgrade-request-"));
  mkdirSync(path.join(root, "status"));
  writeFileSync(path.join(root, "status", "agent.json"), "{}");
  env = { POLYNOVEA_UPGRADE_REQUEST_DIR: path.join(root, "data", "upgrade-requests"), POLYNOVEA_UPGRADE_STATUS_DIR: path.join(root, "status") };
  data.open = null;
  data.requested = [];
  data.recorded = [];
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("startUpgrade", () => {
  it("records the request and writes request.json with the release id, private to the CMS", async () => {
    const result = await startUpgrade({ actorId: "admin-1", releaseId: "0.4.1+bbbbbbb" }, env, check());
    expect(result).toMatchObject({ releaseId: "0.4.1+bbbbbbb", rollback: "compatible" });
    expect(data.requested).toEqual([expect.objectContaining({ fromRelease: "0.4.0+aaaaaaa", toRelease: "0.4.1+bbbbbbb", toVersion: "0.4.1", rollbackMode: "compatible", requestedBy: "admin-1" })]);
    const file = path.join(root, "data", "upgrade-requests", "request.json");
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ releaseId: "0.4.1+bbbbbbb", requestId: result.requestId });
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("needs an acknowledgement when a failed upgrade would restore the backup", async () => {
    await expect(startUpgrade({ actorId: "a", releaseId: "0.4.1+bbbbbbb" }, env, check({ rollback: "restore" }))).rejects.toMatchObject({ status: 428 });
    expect(data.requested).toEqual([]);
    await expect(startUpgrade({ actorId: "a", releaseId: "0.4.1+bbbbbbb", acknowledgeRestore: true }, env, check({ rollback: "restore" }))).resolves.toMatchObject({ rollback: "restore" });
  });

  it("refuses without an agent, without a newer verified release, or when the channel moved", async () => {
    mkdirSync(path.join(root, "empty-status"));
    await expect(startUpgrade({ actorId: "a", releaseId: "0.4.1+bbbbbbb" }, { ...env, POLYNOVEA_UPGRADE_STATUS_DIR: path.join(root, "empty-status") }, check())).rejects.toMatchObject({ status: 409 });
    await expect(startUpgrade({ actorId: "a", releaseId: "0.4.1+bbbbbbb" }, { ...env, POLYNOVEA_UPGRADE_STATUS_DIR: path.join(root, "missing") }, check())).rejects.toMatchObject({ status: 409 });
    await expect(startUpgrade({ actorId: "a", releaseId: "0.4.1+bbbbbbb" }, env, check({}, { upgradeAvailable: false }))).rejects.toThrow(/No newer signed release/);
    await expect(startUpgrade({ actorId: "a", releaseId: "0.4.1+bbbbbbb" }, env, check({}, { latest: null, error: "release.json's signature does not verify" }))).rejects.toThrow(/signature/);
    await expect(startUpgrade({ actorId: "a", releaseId: "0.4.0+zzzzzzz" }, env, check())).rejects.toThrow(/changed/);
    expect(data.requested).toEqual([]);
  });
});

describe("agent status", () => {
  const statusFile = (value: Record<string, unknown>) => writeFileSync(path.join(root, "status", "status.json"), JSON.stringify(value));
  const open = (requestedAt: string, status = "requested") => {
    data.open = { request_id: "11111111-1111-4111-8111-111111111111", to_release: "0.4.1+bbbbbbb", requested_at: requestedAt, status };
  };

  it("parses only known fields and scrubs connection strings", () => {
    const parsed = parseAgentStatus(JSON.stringify({
      schema: 1, releaseId: "0.4.1+bbbbbbb", status: "failed", digest: "sha256:zz", startedAt: "2026-11-24T00:00:00Z", extra: "x",
      steps: [{ step: "migrate", outcome: "failed", at: "t", detail: "at postgresql://u:p@h/db" }, { step: "rm -rf", outcome: "ok", at: "t" }],
    }));
    expect(parsed).toEqual({ releaseId: "0.4.1+bbbbbbb", status: "failed", digest: null, startedAt: "2026-11-24T00:00:00Z", steps: [{ step: "migrate", outcome: "failed", at: "t", detail: "at [redacted]" }] });
    expect(parseAgentStatus("not json")).toBeNull();
    expect(parseAgentStatus(JSON.stringify({ schema: 2 }))).toBeNull();
  });

  it("records the steps of the open request and clears request.json when final", async () => {
    open("2026-11-24T00:00:00.000Z");
    mkdirSync(path.join(root, "data", "upgrade-requests"), { recursive: true });
    writeFileSync(path.join(root, "data", "upgrade-requests", "request.json"), "{}");
    statusFile({ schema: 1, releaseId: "0.4.1+bbbbbbb", status: "rolled_back", digest: `sha256:${"b".repeat(64)}`, startedAt: "2026-11-24T00:00:05Z", steps: [{ step: "health", outcome: "failed", at: "t" }] });
    expect(await ingestAgentStatus(env)).toBe("rolled_back");
    expect(data.recorded[0]).toMatchObject({ status: "rolled_back", steps: [{ step: "health", outcome: "failed" }] });
    expect(existsSync(path.join(root, "data", "upgrade-requests", "request.json"))).toBe(false);
  });

  it("ignores a status file from another release or an older run", async () => {
    open("2026-11-24T10:00:00.000Z");
    statusFile({ schema: 1, releaseId: "0.4.1+bbbbbbb", status: "succeeded", startedAt: "2026-11-23T00:00:00Z", steps: [] });
    expect(await ingestAgentStatus(env, () => Date.parse("2026-11-24T10:01:00Z"))).toBe("requested");
    statusFile({ schema: 1, releaseId: "0.3.0+ccccccc", status: "succeeded", startedAt: "2026-11-24T10:00:30Z", steps: [] });
    expect(await ingestAgentStatus(env, () => Date.parse("2026-11-24T10:01:00Z"))).toBe("requested");
    expect(data.recorded).toEqual([]);
  });

  it("closes a request the agent never picked up after 15 minutes", async () => {
    open("2026-11-24T10:00:00.000Z");
    expect(await ingestAgentStatus(env, () => Date.parse("2026-11-24T10:00:00Z") + PICKUP_TIMEOUT_MS + 1)).toBe("failed");
    expect(data.recorded[0]).toMatchObject({ status: "failed", steps: [{ step: "request", outcome: "failed" }] });
  });

  it("closes a row the agent left running for 4 hours, keeping its steps", async () => {
    data.open = { request_id: "11111111-1111-4111-8111-111111111111", to_release: "0.4.1+bbbbbbb", requested_at: "2026-11-24T00:00:00.000Z", status: "running", steps_json: [{ step: "start", outcome: "started", at: "t" }] };
    expect(await ingestAgentStatus(env, () => Date.parse("2026-11-24T00:00:00Z") + RUNNING_TIMEOUT_MS - 1)).toBe("running");
    expect(data.recorded).toEqual([]);
    expect(await ingestAgentStatus(env, () => Date.parse("2026-11-24T00:00:00Z") + RUNNING_TIMEOUT_MS + 1)).toBe("failed");
    expect(data.recorded[0]).toMatchObject({ status: "failed", steps: [{ step: "start" }, { step: "agent", outcome: "failed" }] });
  });

    it("does nothing without an open upgrade", async () => {
    expect(await ingestAgentStatus(env)).toBeNull();
  });
});
