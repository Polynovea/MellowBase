import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import type pg from "pg";
import { localEndpoint } from "./connect";
import { DatabaseSetupError, setupFailure } from "./errors";
import { provisionDatabase, type ProvisionDeps, type ProvisionedDatabase } from "./provision";
import type { BackupEvent, SetupEvent } from "./stream";
import { MINIMUM_SERVER_VERSION_NUM, parseServerVersionNum } from "./checks";
import { imageLocalServerHost, imagePaths } from "./localServerImage";

/**
 * "On this server": the bundled PostgreSQL on the VM's data disk, with pgBackRest backups. Setup is
 * not finished until stanza-create, check, a full backup and verify have all passed. A real restore
 * test needs a scratch database and time, so it is recorded as the worker's first job instead.
 *
 * Everything that touches the operating system goes through LocalServerHost, so this flow is tested
 * with fakes here; the real host is the server image's (localServerImage.ts and deploy/image/local-db.sh:
 * start command, socket path, the local admin login and the archive_command in postgresql.conf).
 */

export interface LocalServerHost {
  /** Filesystem device IDs of the data directory and of the root directory "/". */
  filesystemDevices(dataDir: string): Promise<{ data: string; root: string }>;
  /** Starts (or confirms running) the bundled PostgreSQL. */
  startPostgres(): Promise<void>;
  /** The bundled server's local administrator, signed in to `database`. */
  adminClient(database: string): Promise<pg.Client>;
  /** The repository encryption password in an existing pgBackRest config, so a rerun keeps the same repository. */
  readPgBackRestCipherPass(): Promise<string | null>;
  /** Writes pgBackRest's config (root/postgres-only file). */
  writePgBackRestConfig(contents: string): Promise<void>;
  /** Runs pgbackrest with these arguments. Output goes to the server log only. */
  pgbackrest(args: readonly string[]): Promise<{ code: number }>;
}

export type BackupChoice =
  | { kind: "same-server" }
  | { kind: "s3"; bucket: string; region: string }
  | { kind: "azure"; account: string; container: string };

export interface BackupOption {
  kind: BackupChoice["kind"];
  title: string;
  recommended: boolean;
  cost: string;
  warning?: string;
}

/** What the wizard shows. Prices are approximate list prices; the cloud's own bill is what counts. */
export const BACKUP_OPTIONS: readonly BackupOption[] = Object.freeze([
  {
    kind: "s3",
    title: "Amazon S3 bucket (recommended on AWS)",
    recommended: true,
    cost: "Paid: roughly US$0.023 per GB per month (S3 Standard, varies by region) plus small request charges, billed by AWS.",
  },
  {
    kind: "azure",
    title: "Azure Blob Storage container (recommended on Azure)",
    recommended: true,
    cost: "Paid: roughly US$0.02 per GB per month (Blob Hot tier, locally redundant, varies by region) plus small request charges, billed by Azure.",
  },
  {
    kind: "same-server",
    title: "On this server's data disk",
    recommended: false,
    cost: "Free: uses space on this server's data disk.",
    warning: "If this server or its data disk is lost, the backups are lost with it. Use this only for trials, or move backups off the server soon.",
  },
]);

const S3_BUCKET = /^(?!\d+\.\d+\.\d+\.\d+$)[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const AWS_REGION = /^[a-z]{2}(?:-[a-z]+)+-\d$/;
const AZURE_ACCOUNT = /^[a-z0-9]{3,24}$/;
const AZURE_CONTAINER = /^(?!.*--)[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;

/** Validates the browser's choice. These values go into pgBackRest's config file, so the patterns are strict. */
export function parseBackupChoice(body: unknown): BackupChoice {
  const value = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const text = (key: string) => (typeof value[key] === "string" ? (value[key] as string).trim() : "");
  switch (value.kind) {
    case "same-server":
      return { kind: "same-server" };
    case "s3": {
      const bucket = text("bucket");
      const region = text("region");
      if (!S3_BUCKET.test(bucket) || bucket.includes("..")) throw new DatabaseSetupError("Enter the S3 bucket's name (lowercase letters, digits, dots and hyphens).", "backup input");
      if (!AWS_REGION.test(region)) throw new DatabaseSetupError("Enter the bucket's AWS region, for example eu-west-1.", "backup input");
      return { kind: "s3", bucket, region };
    }
    case "azure": {
      const account = text("account");
      const container = text("container");
      if (!AZURE_ACCOUNT.test(account)) throw new DatabaseSetupError("Enter the storage account's name (3 to 24 lowercase letters and digits).", "backup input");
      if (!AZURE_CONTAINER.test(container)) throw new DatabaseSetupError("Enter the container's name (lowercase letters, digits and single hyphens).", "backup input");
      return { kind: "azure", account, container };
    }
    default:
      throw new DatabaseSetupError("Choose where backups are kept.", "backup input");
  }
}

export const STANZA = "polynovea";
export const LOCAL_DATABASE = "polynovea";

export interface PgBackRestSettings {
  dataDir: string;
  port: number;
  socketPath: string;
  cipherPass: string;
  /** Repository directory for the same-server option (on the data disk). */
  localRepoPath: string;
}

/** pgBackRest's config. The cloud repositories use the VM's own role or managed identity: no keys in the file. */
export function pgBackRestConfig(choice: BackupChoice, settings: PgBackRestSettings): string {
  if (!/^[A-Za-z0-9_-]{32,}$/.test(settings.cipherPass)) throw new Error("Unexpected repository password format");
  for (const value of [settings.dataDir, settings.socketPath, settings.localRepoPath]) {
    if (!/^\/[A-Za-z0-9._/-]+$/.test(value)) throw new Error("Unexpected path in pgBackRest settings");
  }
  const repo = choice.kind === "s3"
    ? [`repo1-type=s3`, `repo1-s3-bucket=${choice.bucket}`, `repo1-s3-region=${choice.region}`, `repo1-s3-endpoint=s3.${choice.region}.amazonaws.com`, `repo1-s3-key-type=auto`, `repo1-path=/polynovea`, `repo1-retention-full=7`]
    : choice.kind === "azure"
      ? [`repo1-type=azure`, `repo1-azure-account=${choice.account}`, `repo1-azure-container=${choice.container}`, `repo1-azure-key-type=auto`, `repo1-path=/polynovea`, `repo1-retention-full=7`]
      : [`repo1-type=posix`, `repo1-path=${settings.localRepoPath}`, `repo1-retention-full=2`];
  return [
    "# Written by the Polynovea CMS setup wizard.",
    "[global]",
    ...repo,
    "repo1-cipher-type=aes-256-cbc",
    `repo1-cipher-pass=${settings.cipherPass}`,
    "start-fast=y",
    "log-level-console=warn",
    "",
    `[${STANZA}]`,
    `pg1-path=${settings.dataDir}`,
    `pg1-port=${settings.port}`,
    `pg1-socket-path=${settings.socketPath}`,
    "",
  ].join("\n");
}

const BACKUP_STEPS: ReadonlyArray<{ id: string; label: string; args: readonly string[]; fix: string }> = [
  { id: "stanza-create", label: "Preparing the backup store", args: [`--stanza=${STANZA}`, "stanza-create"], fix: "The backup store couldn't be prepared. Check that this server's role or managed identity may write to the bucket or container, then try again." },
  { id: "check", label: "Checking backups and WAL archiving", args: [`--stanza=${STANZA}`, "check"], fix: "The backup check failed: the database's changes are not reaching the backup store. Check the bucket or container access, then try again." },
  { id: "backup", label: "Taking the first full backup", args: [`--stanza=${STANZA}`, "--type=full", "backup"], fix: "The first full backup failed. Check the backup store has space and is reachable, then try again." },
  { id: "verify", label: "Verifying the backup", args: [`--stanza=${STANZA}`, "verify"], fix: "The first backup could not be verified, so setup stopped. Try again; if it keeps failing, choose a different backup store." },
];

export interface LocalServerContext {
  host: LocalServerHost;
  backup: BackupChoice;
  dataDir: string;
  port: number;
  socketPath: string;
  localRepoPath: string;
  emit: (event: SetupEvent) => void;
  saveConfig: (result: ProvisionedDatabase) => Promise<void>;
  /** Records that a real restore test is due: the backup worker's first job. */
  recordRestoreTestPending: () => Promise<void>;
  provision?: ProvisionDeps;
  generateSecret?: () => string;
}

const LISTEN_OK = new Set(["", "127.0.0.1", "localhost"]);

export async function runLocalServerSetup(context: LocalServerContext): Promise<ProvisionedDatabase> {
  const { host, emit } = context;
  const step = async <T>(id: string, label: string, run: () => Promise<T>, fix: string): Promise<T> => {
    const event = (status: BackupEvent["status"], message?: string): BackupEvent => ({ type: "backup", id, label, status, ...(message ? { message } : {}) });
    emit(event("running"));
    try {
      const result = await run();
      emit(event("passed"));
      return result;
    } catch (error) {
      const failure = error instanceof DatabaseSetupError ? error : setupFailure(`local ${id}`, fix, error);
      emit(event("failed", failure.message));
      throw failure;
    }
  };

  await step("disk", "Checking the data disk", async () => {
    const devices = await host.filesystemDevices(context.dataDir);
    if (devices.data === devices.root) {
      throw new DatabaseSetupError("The database folder is on this server's main (root) disk. Attach a separate data disk for the database, then try again.", "local disk");
    }
  }, "We couldn't check which disk holds the database folder.");

  await step("start", "Starting the database on this server", () => host.startPostgres(), "The database on this server didn't start. Restart the server, then try again.");

  await step("listen", "Checking the database only listens on this server", async () => {
    const admin = await host.adminClient("postgres");
    try {
      const { rows } = await admin.query<{ listen: string; version: string }>("select current_setting('listen_addresses') as listen, current_setting('server_version_num') as version");
      const addresses = String(rows[0]?.listen ?? "*").split(",").map((part) => part.trim());
      if (!addresses.every((address) => LISTEN_OK.has(address))) {
        throw new DatabaseSetupError("The database on this server accepts connections from other machines. It must listen on this server only (127.0.0.1 or a local socket).", "local listen");
      }
      const version = parseServerVersionNum(rows[0]?.version);
      if (version === null || version < MINIMUM_SERVER_VERSION_NUM) throw new DatabaseSetupError("The database on this server is older than PostgreSQL 15. Update Polynovea CMS's server image.", "local listen");
      const { rows: existing } = await admin.query("select 1 from pg_catalog.pg_database where datname = $1", [LOCAL_DATABASE]);
      if (existing.length === 0) await admin.query(`create database ${LOCAL_DATABASE}`);
    } finally {
      await admin.end().catch(() => {});
    }
  }, "We couldn't check the database on this server.");

  const adminClient = await host.adminClient(LOCAL_DATABASE);
  const result = await provisionDatabase(
    { adminClient, endpoint: localEndpoint("127.0.0.1", context.port), database: LOCAL_DATABASE, mode: "local", emit },
    context.provision,
  );

  const cipherPass = (await host.readPgBackRestCipherPass()) ?? (context.generateSecret ?? (() => randomBytes(32).toString("base64url")))();
  await step("configure", "Setting up backups", () => host.writePgBackRestConfig(pgBackRestConfig(context.backup, {
    dataDir: context.dataDir, port: context.port, socketPath: context.socketPath, cipherPass, localRepoPath: context.localRepoPath,
  })), "Backups couldn't be set up on this server.");

  for (const backupStep of BACKUP_STEPS) {
    await step(backupStep.id, backupStep.label, async () => {
      const { code } = await host.pgbackrest(backupStep.args);
      if (code !== 0) throw new Error(`pgbackrest ${backupStep.args.join(" ")} exited with ${code}`);
    }, backupStep.fix);
  }

  const saved: ProvisionedDatabase = { ...result, backupRepoPassword: cipherPass };
  await context.saveConfig(saved);
  await context.recordRestoreTestPending();
  emit({ type: "done", databaseMode: "local", restoreTestPending: true });
  return saved;
}

// ---------------------------------------------------------------------------------------------------
// The real host's operating-system parts. Starting PostgreSQL and its local admin login depend on the
// server image, so they are passed in (localServerImage.ts).

export interface SystemHostOptions {
  startPostgres: () => Promise<void>;
  adminClient: (database: string) => Promise<pg.Client>;
  pgBackRestConfigPath: string;
  pgBackRestBinary?: string;
  /** Timeout for one pgbackrest run (a first full backup can take a while). */
  timeoutMs?: number;
  /** Extra environment for pgbackrest (PGBACKREST_CONFIG, log and lock paths). PATH is always set. */
  env?: Record<string, string>;
}

export function createSystemLocalServerHost(options: SystemHostOptions): LocalServerHost {
  return {
    async filesystemDevices(dataDir) {
      return { data: String(statSync(dataDir).dev), root: String(statSync("/").dev) };
    },
    startPostgres: options.startPostgres,
    adminClient: options.adminClient,
    async readPgBackRestCipherPass() {
      if (!existsSync(options.pgBackRestConfigPath)) return null;
      const match = /^repo1-cipher-pass=([A-Za-z0-9_-]{32,})$/m.exec(readFileSync(options.pgBackRestConfigPath, "utf8"));
      return match?.[1] ?? null;
    },
    async writePgBackRestConfig(contents) {
      writeFileSync(options.pgBackRestConfigPath, contents, { mode: 0o600 });
    },
    pgbackrest(args) {
      return new Promise((resolve) => {
        execFile(options.pgBackRestBinary ?? "pgbackrest", [...args], { timeout: options.timeoutMs ?? 60 * 60_000, env: { ...options.env, PATH: process.env.PATH ?? "/usr/bin:/bin" } as unknown as NodeJS.ProcessEnv, encoding: "utf8" }, (error, _stdout, stderr) => {
          if (error) console.error("[setup/database] pgbackrest %s failed: %s", args.join(" "), String(stderr).slice(-2000));
          const code = error ? (typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : 1) : 0;
          resolve({ code });
        });
      });
    },
  };
}

// ---------------------------------------------------------------------------------------------------
// What this server image provides.

export const LOCAL_SERVER_UNAVAILABLE =
  "\"On this server\" needs the Polynovea server image, which includes the database and backup software. This server doesn't have it, so choose \"Existing managed database\" or \"Created for you\".";

/**
 * The bundled-database host for this server image, or null when this server is not running the
 * Polynovea server image (then the option is shown as unavailable rather than attempted).
 */
export function localServerHostForThisImage(): LocalServerHost | null {
  return imageLocalServerHost();
}

/** Where the server image keeps the bundled database and its local backups: the data disk. */
export function localServerSettings(): Pick<LocalServerContext, "dataDir" | "port" | "socketPath" | "localRepoPath"> {
  const paths = imagePaths();
  return { dataDir: paths.dataDir, port: paths.port, socketPath: paths.socketDir, localRepoPath: paths.localRepoPath };
}
