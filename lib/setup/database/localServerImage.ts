import { execFile } from "node:child_process";
import { existsSync, mkdirSync, statSync } from "node:fs";
import path from "node:path";
import pg from "pg";
import { createSystemLocalServerHost, type LocalServerHost } from "./localServer";

/**
 * "On this server" inside the Polynovea server image (Dockerfile, deploy/image/).
 *
 * The image runs as one non-root user (`polynovea`, uid 10001). The bundled PostgreSQL 16 runs as that
 * same user, with its data on the data disk mounted at /var/lib/polynovea. deploy/image/local-db.sh
 * creates the cluster on first use and writes its settings:
 *
 * - it listens on 127.0.0.1 and on a unix socket in /var/run/postgresql (mode 0700) only;
 * - the local administrator is `postgres`, reachable only over that socket by peer authentication for
 *   the image's own OS user (pg_ident map), so no superuser password exists anywhere;
 * - polynovea_owner and polynovea_app may sign in only to the `polynovea` database, only from
 *   127.0.0.1, only with scram-sha-256; every other connection is rejected;
 * - archive_command pushes WAL to pgBackRest, whose config lives on the data disk.
 *
 * The image sets POLYNOVEA_IMAGE=1; elsewhere (a developer machine, `next start` on a VM without the
 * image) this returns null and the wizard shows the option as unavailable.
 */

type Env = Record<string, string | undefined>;

export const IMAGE_DATA_ROOT = "/var/lib/polynovea";
export const IMAGE_LOCAL_DB_SCRIPT = "/opt/polynovea/bin/local-db.sh";
export const IMAGE_SOCKET_DIR = "/var/run/postgresql";
export const IMAGE_PORT = 5432;
export const IMAGE_ADMIN_USER = "postgres";

export interface ImagePaths {
  dataRoot: string;
  dataDir: string;
  localRepoPath: string;
  pgBackRestConfigPath: string;
  pgBackRestLogPath: string;
  socketDir: string;
  port: number;
  localDbScript: string;
}

/** Where everything lives in the image. All on the data disk except the socket and the script. */
export function imagePaths(env: Env = process.env): ImagePaths {
  const dataRoot = env.POLYNOVEA_DATA_ROOT?.trim() || IMAGE_DATA_ROOT;
  return {
    dataRoot,
    dataDir: path.posix.join(dataRoot, "postgresql"),
    localRepoPath: path.posix.join(dataRoot, "pgbackrest"),
    pgBackRestConfigPath: path.posix.join(dataRoot, "etc", "pgbackrest.conf"),
    pgBackRestLogPath: path.posix.join(dataRoot, "log", "pgbackrest"),
    socketDir: IMAGE_SOCKET_DIR,
    port: IMAGE_PORT,
    localDbScript: IMAGE_LOCAL_DB_SCRIPT,
  };
}

/** True when this process runs in the server image and the bundled database's tools are present. */
export function runningInServerImage(env: Env = process.env, exists: (file: string) => boolean = existsSync): boolean {
  return env.POLYNOVEA_IMAGE === "1" && exists(IMAGE_LOCAL_DB_SCRIPT);
}

type Runner = (file: string, args: readonly string[], timeoutMs: number) => Promise<void>;

const runScript: Runner = (file, args, timeoutMs) =>
  new Promise((resolve, reject) => {
    execFile(file, [...args], { timeout: timeoutMs, encoding: "utf8", env: { PATH: process.env.PATH ?? "/usr/bin:/bin" } as unknown as NodeJS.ProcessEnv }, (error, _stdout, stderr) => {
      if (error) {
        // The script's own output names paths and PostgreSQL messages; it goes to the server log only.
        console.error("[setup/database] %s %s failed: %s", path.basename(file), args.join(" "), String(stderr).slice(-2000));
        reject(new Error(`${path.basename(file)} ${args.join(" ")} failed`));
        return;
      }
      resolve();
    });
  });

export interface ImageHostDeps {
  run?: Runner;
  connect?: (config: pg.ClientConfig) => Promise<pg.Client>;
  mkdir?: (dir: string) => void;
  stat?: (file: string) => { dev: number | bigint };
}

const connectClient = async (config: pg.ClientConfig) => {
  const client = new pg.Client(config);
  await client.connect();
  return client;
};

/** The image's LocalServerHost. Exported with its dependencies for tests. */
export function createImageLocalServerHost(paths: ImagePaths = imagePaths(), deps: ImageHostDeps = {}): LocalServerHost {
  const run = deps.run ?? runScript;
  const connect = deps.connect ?? connectClient;
  const mkdir = deps.mkdir ?? ((dir: string) => mkdirSync(dir, { recursive: true, mode: 0o700 }));
  const stat = deps.stat ?? statSync;

  const system = createSystemLocalServerHost({
    startPostgres: () => run(paths.localDbScript, ["start"], 120_000),
    adminClient: (database) => connect({
      host: paths.socketDir,
      port: paths.port,
      user: IMAGE_ADMIN_USER,
      database,
      connectionTimeoutMillis: 10_000,
    }),
    pgBackRestConfigPath: paths.pgBackRestConfigPath,
    env: {
      PGBACKREST_CONFIG: paths.pgBackRestConfigPath,
      PGBACKREST_LOG_PATH: paths.pgBackRestLogPath,
      PGBACKREST_LOCK_PATH: "/tmp/pgbackrest",
    },
  });

  return {
    ...system,
    async filesystemDevices(dataDir) {
      // The cluster's folder does not exist before the first start; its parent is the data disk.
      mkdir(dataDir);
      mkdir(path.posix.dirname(paths.pgBackRestConfigPath));
      mkdir(paths.pgBackRestLogPath);
      return { data: String(stat(dataDir).dev), root: String(stat("/").dev) };
    },
  };
}

/** The image's host, or null outside the image. */
export function imageLocalServerHost(env: Env = process.env): LocalServerHost | null {
  return runningInServerImage(env) ? createImageLocalServerHost(imagePaths(env)) : null;
}
