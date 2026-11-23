import { describe, expect, it, vi } from "vitest";
import { localServerSettings } from "./localServer";
import { createImageLocalServerHost, IMAGE_LOCAL_DB_SCRIPT, imageLocalServerHost, imagePaths, runningInServerImage } from "./localServerImage";

describe("server image detection", () => {
  it("needs both the image marker and the bundled database script", () => {
    expect(runningInServerImage({ POLYNOVEA_IMAGE: "1" }, () => true)).toBe(true);
    expect(runningInServerImage({ POLYNOVEA_IMAGE: "1" }, () => false)).toBe(false);
    expect(runningInServerImage({}, () => true)).toBe(false);
    expect(runningInServerImage({ POLYNOVEA_IMAGE: "true" }, () => true)).toBe(false);
  });

  it("is null on a machine without the image, so the wizard keeps the option unavailable", () => {
    expect(imageLocalServerHost({})).toBeNull();
  });
});

describe("image paths", () => {
  it("keeps the database, its backups and pgBackRest's config on the data disk", () => {
    const paths = imagePaths({});
    expect(paths.dataRoot).toBe("/var/lib/polynovea");
    for (const value of [paths.dataDir, paths.localRepoPath, paths.pgBackRestConfigPath, paths.pgBackRestLogPath]) {
      expect(value.startsWith("/var/lib/polynovea/")).toBe(true);
    }
    expect(paths.socketDir).toBe("/var/run/postgresql");
    expect(paths.localDbScript).toBe(IMAGE_LOCAL_DB_SCRIPT);
  });

  it("is what the wizard uses", () => {
    const paths = imagePaths({});
    expect(localServerSettings()).toEqual({ dataDir: paths.dataDir, port: 5432, socketPath: paths.socketDir, localRepoPath: paths.localRepoPath });
  });
});

describe("the image's LocalServerHost", () => {
  const paths = imagePaths({});

  it("starts PostgreSQL through the image's script", async () => {
    const run = vi.fn(async () => {});
    await createImageLocalServerHost(paths, { run }).startPostgres();
    expect(run).toHaveBeenCalledWith(IMAGE_LOCAL_DB_SCRIPT, ["start"], expect.any(Number));
  });

  it("signs in as the local administrator over the unix socket, with no password", async () => {
    const client = { end: vi.fn() };
    const connect = vi.fn(async () => client as never);
    await createImageLocalServerHost(paths, { connect }).adminClient("polynovea");
    const config = (connect.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
    expect(config).toMatchObject({ host: "/var/run/postgresql", port: 5432, user: "postgres", database: "polynovea" });
    expect(config).not.toHaveProperty("password");
  });

  it("creates the database folder before checking which disk it is on", async () => {
    const made: string[] = [];
    const stat = vi.fn((file: string) => ({ dev: file === "/" ? 1 : 2 }));
    const host = createImageLocalServerHost(paths, { mkdir: (dir) => made.push(dir), stat });
    expect(await host.filesystemDevices(paths.dataDir)).toEqual({ data: "2", root: "1" });
    expect(made[0]).toBe(paths.dataDir);
    expect(made).toContain("/var/lib/polynovea/etc");
  });

  it("reports the same device when the folder is on the root disk, so the wizard refuses it", async () => {
    const host = createImageLocalServerHost(paths, { mkdir: () => {}, stat: () => ({ dev: 7 }) });
    const devices = await host.filesystemDevices(paths.dataDir);
    expect(devices.data).toBe(devices.root);
  });
});
