import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import type pg from "pg";
import { DatabaseSetupError } from "./errors";
import { BACKUP_OPTIONS, parseBackupChoice, pgBackRestConfig, runLocalServerSetup, type BackupChoice, type LocalServerHost } from "./localServer";
import type { ProvisionedDatabase } from "./provision";
import type { SetupEvent } from "./stream";
import { adminRoutes, fakeClient, ownerRoutes } from "./testFakes";

const CIPHER = "c".repeat(43);
const SETTINGS = { dataDir: "/data/postgresql/16/main", port: 5432, socketPath: "/var/run/postgresql", cipherPass: CIPHER, localRepoPath: "/data/pgbackrest" };

let logged: MockInstance;
beforeEach(() => { logged = vi.spyOn(console, "error").mockImplementation(() => {}); });
afterEach(() => logged.mockRestore());

function host(options: { sameDisk?: boolean; listen?: string; failing?: string; existingCipher?: string | null } = {}) {
  const calls: string[] = [];
  let config = "";
  const fake: LocalServerHost = {
    filesystemDevices: async () => ({ data: options.sameDisk ? "2049" : "2065", root: "2049" }),
    startPostgres: async () => { calls.push("start"); },
    adminClient: async (database: string) => {
      calls.push(`admin:${database}`);
      return fakeClient([
        [/listen_addresses/, () => ({ rows: [{ listen: options.listen ?? "127.0.0.1", version: "160004" }] })],
        [/from pg_catalog\.pg_database/, () => ({ rows: [] })],
        ...adminRoutes(),
      ]).client;
    },
    readPgBackRestCipherPass: async () => options.existingCipher ?? null,
    writePgBackRestConfig: async (contents) => { config = contents; calls.push("write-config"); },
    pgbackrest: async (args) => {
      const command = args.at(-1)!;
      calls.push(`pgbackrest:${command}`);
      return { code: command === options.failing ? 1 : 0 };
    },
  };
  return { fake, calls, config: () => config };
}

async function run(h: ReturnType<typeof host>, backup: BackupChoice = { kind: "s3", bucket: "acme-backups", region: "eu-west-1" }) {
  const events: SetupEvent[] = [];
  const saved: ProvisionedDatabase[] = [];
  const recorded = vi.fn(async () => {});
  const result = await runLocalServerSetup({
    host: h.fake, backup, dataDir: SETTINGS.dataDir, port: 5432, socketPath: SETTINGS.socketPath, localRepoPath: SETTINGS.localRepoPath,
    emit: (event) => events.push(event),
    saveConfig: async (value) => { saved.push(value); },
    recordRestoreTestPending: recorded,
    generateSecret: () => CIPHER,
    provision: {
      openClient: async () => fakeClient(ownerRoutes()).client as pg.Client,
      migrate: async () => ({ applied: [], skipped: [] }),
      generatePassword: (() => { let n = 0; return () => `role-password-${++n}-${"y".repeat(30)}`; })(),
    },
  }).then((value): ProvisionedDatabase | Error => value, (e: Error) => e);
  return { result, events, saved, recorded };
}

describe("runLocalServerSetup", () => {
  it("starts the bundled server, provisions it, and saves only after stanza-create, check, a full backup and verify pass", async () => {
    const h = host();
    const { result, events, saved, recorded } = await run(h);
    expect(result).not.toBeInstanceOf(Error);
    expect(h.calls).toEqual(["start", "admin:postgres", "admin:polynovea", "write-config", "pgbackrest:stanza-create", "pgbackrest:check", "pgbackrest:backup", "pgbackrest:verify"]);
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ databaseMode: "local", backupRepoPassword: CIPHER, database: { host: "127.0.0.1", port: 5432, name: "polynovea", caBundleId: null } });
    expect(recorded).toHaveBeenCalledTimes(1);
    expect(events.at(-1)).toEqual({ type: "done", databaseMode: "local", restoreTestPending: true });
    expect(JSON.stringify(events)).not.toContain(CIPHER);
  });

  it.each(["stanza-create", "check", "backup", "verify"])("blocks setup when %s fails", async (failing) => {
    const h = host({ failing });
    const { result, saved, recorded, events } = await run(h);
    expect(result).toBeInstanceOf(DatabaseSetupError);
    expect(saved).toEqual([]);
    expect(recorded).not.toHaveBeenCalled();
    expect(events.at(-1)).toMatchObject({ type: "backup", id: failing, status: "failed" });
  });

  it("refuses a data folder on the root disk before starting anything", async () => {
    const h = host({ sameDisk: true });
    const { result } = await run(h);
    expect((result as Error).message).toMatch(/main \(root\) disk/);
    expect(h.calls).toEqual([]);
  });

  it.each(["*", "0.0.0.0", "127.0.0.1,10.0.0.4", "::"])("refuses a bundled server listening on %s", async (listen) => {
    const { result, saved } = await run(host({ listen }));
    expect((result as Error).message).toMatch(/listen on this server only/);
    expect(saved).toEqual([]);
  });

  it("keeps the existing repository password on a rerun", async () => {
    const h = host({ existingCipher: "e".repeat(43) });
    const { saved } = await run(h);
    expect(saved[0].backupRepoPassword).toBe("e".repeat(43));
    expect(h.config()).toContain(`repo1-cipher-pass=${"e".repeat(43)}`);
  });
});

describe("pgBackRestConfig", () => {
  it("uses the VM's own role for S3, with client-side encryption", () => {
    const text = pgBackRestConfig({ kind: "s3", bucket: "acme-backups", region: "eu-west-1" }, SETTINGS);
    expect(text).toContain("repo1-s3-key-type=auto");
    expect(text).toContain("repo1-cipher-type=aes-256-cbc");
    expect(text).not.toMatch(/s3-key=|s3-key-secret=/);
    expect(text).toContain("[polynovea]\npg1-path=/data/postgresql/16/main");
  });

  it("uses the managed identity for Azure and the data disk for the free option", () => {
    expect(pgBackRestConfig({ kind: "azure", account: "acmebackups", container: "pg" }, SETTINGS)).toContain("repo1-azure-key-type=auto");
    expect(pgBackRestConfig({ kind: "same-server" }, SETTINGS)).toContain("repo1-type=posix\nrepo1-path=/data/pgbackrest");
  });
});

describe("parseBackupChoice", () => {
  it("accepts the three options", () => {
    expect(parseBackupChoice({ kind: "same-server" })).toEqual({ kind: "same-server" });
    expect(parseBackupChoice({ kind: "s3", bucket: "acme.backups-1", region: "us-east-1" })).toEqual({ kind: "s3", bucket: "acme.backups-1", region: "us-east-1" });
    expect(parseBackupChoice({ kind: "azure", account: "acme01", container: "pg-backups" })).toEqual({ kind: "azure", account: "acme01", container: "pg-backups" });
  });

  it.each([
    { kind: "s3", bucket: "acme\nrepo1-type=posix", region: "eu-west-1" },
    { kind: "s3", bucket: "acme", region: "eu-west-1\nx=y" },
    { kind: "s3", bucket: "192.168.1.1", region: "eu-west-1" },
    { kind: "azure", account: "Acme", container: "pg" },
    { kind: "azure", account: "acme", container: "a--b" },
    { kind: "ftp" },
  ])("refuses %j (values go into a config file)", (body) => {
    expect(() => parseBackupChoice(body)).toThrow(DatabaseSetupError);
  });
});

describe("BACKUP_OPTIONS", () => {
  it("shows a cost for every option and warns that same-server backups die with the server", () => {
    for (const option of BACKUP_OPTIONS) expect(option.cost).toMatch(/^(Paid|Free):/);
    const free = BACKUP_OPTIONS.find((option) => option.kind === "same-server")!;
    expect(free.recommended).toBe(false);
    expect(free.warning).toMatch(/lost with it/);
  });
});
