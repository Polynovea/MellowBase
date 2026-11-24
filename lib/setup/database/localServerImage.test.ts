import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { localServerSettings } from "./localServer";
import { createImageLocalServerHost, IMAGE_LOCAL_DB_SCRIPT, imageLocalServerHost, imagePaths, imagePgBackRestEnv, runningInServerImage } from "./localServerImage";

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
    const paths = imagePaths();
    expect(paths.dataRoot).toBe("/var/lib/polynovea");
    for (const value of [paths.dataDir, paths.localRepoPath, paths.pgBackRestConfigPath, paths.pgBackRestLogPath]) {
      expect(value.startsWith("/var/lib/polynovea/")).toBe(true);
    }
    expect(paths.socketDir).toBe("/var/run/postgresql");
    expect(paths.localDbScript).toBe(IMAGE_LOCAL_DB_SCRIPT);
  });

  it("is fixed: no environment override in the wizard, local-db.sh or the entrypoint, so all three agree", () => {
    vi.stubEnv("POLYNOVEA_DATA_ROOT", "/tmp/elsewhere");
    try {
      expect(imagePaths().dataRoot).toBe("/var/lib/polynovea");
      expect(localServerSettings().dataDir).toBe("/var/lib/polynovea/postgresql");
    } finally {
      vi.unstubAllEnvs();
    }
    const root = path.resolve(__dirname, "..", "..", "..");
    const localDb = readFileSync(path.join(root, "docker/local-db.sh"), "utf8");
    const entrypoint = readFileSync(path.join(root, "docker/entrypoint.mjs"), "utf8");
    for (const source of [localDb, entrypoint]) expect(source).not.toMatch(/POLYNOVEA_DATA_ROOT/);
    expect(localDb).toMatch(/^DATA_ROOT=\/var\/lib\/polynovea\b/m);
    expect(entrypoint).toMatch(/^const DATA_ROOT = "\/var\/lib\/polynovea";$/m);
  });

  it("quotes every path in archive_command (PostgreSQL runs it through a shell)", () => {
    const localDb = readFileSync(path.resolve(__dirname, "..", "..", "..", "docker/local-db.sh"), "utf8");
    const line = localDb.split(/\r?\n/).find((l) => l.startsWith("archive_command = ")) ?? "";
    expect(line).toContain('--config="$PGBACKREST_CONFIG"');
    expect(line).toContain('--log-path="$LOG_DIR/pgbackrest"');
    expect(line).toContain('archive-push "%p"');
  });

  it("is what the wizard uses", () => {
    const paths = imagePaths();
    expect(localServerSettings()).toEqual({ dataDir: paths.dataDir, port: 5432, socketPath: paths.socketDir, localRepoPath: paths.localRepoPath });
  });
});

describe("the image's LocalServerHost", () => {
  const paths = imagePaths();

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

  it("runs pgBackRest with its config and logs on the data disk, signed in as the local administrator", () => {
    expect(imagePgBackRestEnv(paths)).toEqual({
      PGBACKREST_CONFIG: "/var/lib/polynovea/etc/pgbackrest.conf",
      PGBACKREST_LOG_PATH: "/var/lib/polynovea/log/pgbackrest",
      PGBACKREST_LOCK_PATH: "/tmp/pgbackrest",
      PGBACKREST_PG1_USER: "postgres",
    });
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
