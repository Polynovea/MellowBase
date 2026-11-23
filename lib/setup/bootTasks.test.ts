import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { modeState } = vi.hoisted(() => ({ modeState: { mode: "setup" as "setup" | "running" | "unavailable" } }));

vi.mock("./keyRing.ts", () => ({ loadKeyRing: vi.fn(() => null), masterKeyPath: vi.fn(() => "/tmp/master.key") }));
vi.mock("./mode.ts", () => ({
  installConfig: vi.fn(() => null),
  onModeChange: vi.fn(() => () => {}),
  resolveMode: vi.fn(async () => ({ mode: modeState.mode, databaseSource: null, databaseReady: false, reason: "test", checkedAt: 0 })),
}));
vi.mock("./peerStamp.ts", () => ({ installPeerStamp: vi.fn(() => true) }));

const { runBootTasks } = await import("./bootTasks");
const { installPeerStamp } = await import("./peerStamp.ts");
const { SetupCodeConfigError, consumeSetupCode, resetSetupCodeForTests, setupCodeExpiresAt } = await import("./setupCode");

function logger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

const LOOPBACK_ENV = { HOSTNAME: "127.0.0.1", PORT: "3000" };

beforeEach(() => {
  resetSetupCodeForTests();
  modeState.mode = "setup";
  vi.mocked(installPeerStamp).mockClear();
});

afterEach(() => vi.clearAllMocks());

describe("boot in setup mode", () => {
  it("issues the setup code and prints it with the setup URL", async () => {
    const log = logger();
    await runBootTasks({ ...LOOPBACK_ENV }, log);
    const printed = log.info.mock.calls.flat().join("\n");
    expect(printed).toContain("Open http://127.0.0.1:3000/setup");
    const match = /Setup code: ([0-9A-Z-]{30})/.exec(printed);
    expect(match).not.toBeNull();
    expect(consumeSetupCode(match![1])).toBe(true);
  });

  it("installs the peer stamp the setup guards rely on", async () => {
    await runBootTasks({ ...LOOPBACK_ENV }, logger());
    expect(installPeerStamp).toHaveBeenCalledTimes(1);
  });

  it("uses POLYNOVEA_SETUP_CODE without printing it, and removes it from the environment", async () => {
    const env: Record<string, string | undefined> = { ...LOOPBACK_ENV, POLYNOVEA_SETUP_CODE: "7K3M9Q2T8VXZ4HNP6RJWBCDEFG" };
    const log = logger();
    await runBootTasks(env, log);
    expect(log.info.mock.calls.flat().join("\n")).not.toContain("7K3M9Q2T8VXZ4HNP6RJWBCDEFG");
    expect("POLYNOVEA_SETUP_CODE" in env).toBe(false);
    expect(consumeSetupCode("7K3M9Q2T8VXZ4HNP6RJWBCDEFG")).toBe(true);
  });

  it("a too-weak POLYNOVEA_SETUP_CODE stops boot", async () => {
    await expect(runBootTasks({ ...LOOPBACK_ENV, POLYNOVEA_SETUP_CODE: "hunter2" }, logger())).rejects.toBeInstanceOf(SetupCodeConfigError);
  });
});

describe("boot outside setup mode", () => {
  it("a running install issues no code and installs no stamp", async () => {
    modeState.mode = "running";
    const log = logger();
    await runBootTasks({ ...LOOPBACK_ENV }, log);
    expect(setupCodeExpiresAt()).toBeNull();
    expect(log.info.mock.calls.flat().join("\n")).not.toContain("Setup code");
    expect(installPeerStamp).not.toHaveBeenCalled();
  });

  it("an unavailable install issues no code but keeps the stamp ready for when it returns to setup", async () => {
    modeState.mode = "unavailable";
    await runBootTasks({ ...LOOPBACK_ENV }, logger());
    expect(setupCodeExpiresAt()).toBeNull();
    expect(installPeerStamp).toHaveBeenCalledTimes(1);
  });
});
