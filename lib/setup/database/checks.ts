import { connect as netConnect, type Socket } from "node:net";
import { connect as tlsConnect } from "node:tls";
import type pg from "pg";
import {
  DatabaseTargetError,
  isManagedDatabaseHostname,
  resolveDatabaseTarget,
  type DatabaseAllowlist,
  type DatabaseTarget,
  type Resolver,
} from "@/lib/infrastructure/guardedNetwork.mjs";
import { pinnedTlsOptions } from "@/lib/infrastructure/postgresTls.mjs";
import { managedDatabaseRoots, type TrustedRoots } from "./caBundles";
import { openClient, remoteEndpoint, type ClientFactory, type DatabaseEndpoint } from "./connect";
import { DatabaseSetupError, setupFailure } from "./errors";

/**
 * The five checks for "Existing managed database", in order: DNS, TCP (5 seconds), TLS verify-full,
 * login (and the login can create roles), PostgreSQL 15 or later. Each failure becomes a plain fix;
 * driver and server messages are logged under a reference, never shown. Everything the server sends
 * (version string, role names, error text) is untrusted.
 */

export type CheckId = "dns" | "tcp" | "tls" | "login" | "version";
export const CHECKS: ReadonlyArray<{ id: CheckId; label: string }> = Object.freeze([
  { id: "dns", label: "Finding the database" },
  { id: "tcp", label: "Reaching it over the network" },
  { id: "tls", label: "Checking its identity (TLS)" },
  { id: "login", label: "Signing in with the admin login" },
  { id: "version", label: "Checking the PostgreSQL version" },
]);

export type CheckEvent = { type: "check"; id: CheckId; label: string; status: "running" | "passed" | "failed"; message?: string };

export interface ManagedDatabaseInput {
  hostname: string;
  port: number;
  database: string;
  user: string;
  password: string;
}

const DATABASE_NAME = /^[a-z_][a-z0-9_]{0,62}$/;
const ADMIN_USER = /^[A-Za-z0-9_.@-]{1,63}$/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

/** Validates the form. Messages name the field, never echo the value. */
export function parseManagedDatabaseInput(body: unknown): ManagedDatabaseInput {
  const value = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const invalid = (message: string): never => {
    throw new DatabaseSetupError(message, "input");
  };
  const hostname = typeof value.hostname === "string" ? value.hostname.trim() : "";
  if (!hostname || hostname.length > 255) invalid("Enter the database's endpoint name.");
  const port = typeof value.port === "number" ? value.port : typeof value.port === "string" && /^\d{1,5}$/.test(value.port.trim()) ? Number(value.port.trim()) : Number.NaN;
  if (!Number.isInteger(port) || port < 1 || port > 65535) invalid("The port must be a whole number from 1 to 65535 (PostgreSQL normally uses 5432).");
  const database = typeof value.database === "string" ? value.database.trim() : "";
  if (!DATABASE_NAME.test(database)) invalid("The database name may use lowercase letters, digits and underscores, starting with a letter or underscore.");
  const user = typeof value.user === "string" ? value.user.trim() : "";
  if (!ADMIN_USER.test(user)) invalid("Enter the admin username (letters, digits, and . _ @ - only).");
  const password = typeof value.password === "string" ? value.password : "";
  if (!password || password.length > 1024 || CONTROL.test(password)) invalid("Enter the admin password.");
  return { hostname, port, database, user, password };
}

// ---------------------------------------------------------------------------------------------------
// Probes. Real ones open sockets to the pinned address only; tests pass fakes.

export type TcpProbe = (address: string, port: number, timeoutMs: number) => Promise<void>;
export type TlsProbe = (endpoint: Extract<DatabaseEndpoint, { kind: "remote" }>, timeoutMs: number) => Promise<void>;

export class ProbeError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "ProbeError";
  }
}

export const tcpProbe: TcpProbe = (address, port, timeoutMs) =>
  new Promise((resolve, reject) => {
    const socket = netConnect({ host: address, port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new ProbeError("ETIMEDOUT"));
    }, timeoutMs);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.end();
      resolve();
    });
    socket.once("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      socket.destroy();
      reject(new ProbeError(error.code ?? "ECONNECT"));
    });
  });

// PostgreSQL's SSLRequest: length 8, code 80877103. The server answers one byte, S or N.
const SSL_REQUEST = Buffer.from([0, 0, 0, 8, 0x04, 0xd2, 0x16, 0x2f]);

export const tlsProbe: TlsProbe = (endpoint, timeoutMs) =>
  new Promise((resolve, reject) => {
    let settled = false;
    let socket: Socket = netConnect({ host: endpoint.address, port: endpoint.port });
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => finish(new ProbeError("ETIMEDOUT")), timeoutMs);
    socket.once("error", (error: NodeJS.ErrnoException) => finish(new ProbeError(error.code ?? "ECONNECT")));
    socket.once("connect", () => socket.write(SSL_REQUEST));
    socket.once("data", (chunk: Buffer) => {
      if (chunk.length !== 1 || chunk[0] !== 0x53 /* S */) {
        finish(new ProbeError(chunk[0] === 0x4e /* N */ ? "ENOTLS" : "EPROTOCOL"));
        return;
      }
      socket.removeAllListeners("error");
      const secure = tlsConnect({ socket, ...pinnedTlsOptions({ servername: endpoint.hostname, ca: endpoint.ca }) });
      socket = secure;
      secure.once("secureConnect", () => finish());
      secure.once("error", (error: NodeJS.ErrnoException) => finish(new ProbeError(error.code ?? "ETLS")));
    });
  });

// ---------------------------------------------------------------------------------------------------
// Plain fixes.

const SECURITY_GROUP = "allow this server in the database's security group or network rules";

export function dnsFix(error: unknown): string {
  if (!(error instanceof DatabaseTargetError) && error instanceof Error && error.message.includes("POLYNOVEA_SETUP_DB_ALLOWLIST")) {
    return "This server's database allowlist setting (POLYNOVEA_SETUP_DB_ALLOWLIST) has an entry it can't read. Ask the server's operator to fix it, then try again.";
  }
  const reason = error instanceof DatabaseTargetError ? error.reason : "not-found";
  switch (reason) {
    case "localhost":
      return "\"localhost\" is this server itself. To keep the database here, go back and choose \"On this server\".";
    case "blocked-address":
      return "That address belongs to this server or to the cloud platform, and can never be used for the database. Enter the endpoint name from your cloud console.";
    case "private-literal":
      return "Enter the database's endpoint name, not an IP address: private IP addresses are not accepted, and a managed database's address can change.";
    case "private-not-allowed":
      return "That name points to a private network address. Private addresses are accepted only for Amazon RDS (…rds.amazonaws.com) and Azure Database for PostgreSQL (…postgres.database.azure.com) endpoints, or for hosts the server's operator lists in POLYNOVEA_SETUP_DB_ALLOWLIST.";
    case "invalid-host":
      return "That is not a valid endpoint name. Copy it from your cloud console, without \"postgres://\", a port or a path.";
    case "invalid-port":
      return "The port must be a whole number from 1 to 65535 (PostgreSQL normally uses 5432).";
    case "dns-timeout":
    case "not-found":
    default:
      return "We couldn't find a database with that name. Check the endpoint name; if the database is private, this server can't see the database's private network: run it in the same VPC or virtual network, or connect the two.";
  }
}

export function tcpFix(error: unknown, port: number): string {
  const code = error instanceof ProbeError ? error.code : "";
  if (code === "ECONNREFUSED") return `Nothing answered on port ${port} at that address. Check the port (PostgreSQL normally uses 5432) and that the database is running.`;
  if (code === "EHOSTUNREACH" || code === "ENETUNREACH") return `This server has no network route to the database. Put both in the same network, or ${SECURITY_GROUP}.`;
  return `The database didn't answer within 5 seconds: ${SECURITY_GROUP} (inbound port ${port}).`;
}

export function tlsFix(error: unknown, hostname: string, roots: TrustedRoots): string {
  const code = error instanceof ProbeError ? error.code : "";
  if (code === "ENOTLS") return "The database does not accept encrypted connections. Turn on TLS (SSL) for it; we never connect without it.";
  if (code === "ETIMEDOUT") return `The database stopped answering while setting up encryption: ${SECURITY_GROUP}, then try again.`;
  if (code === "EPROTOCOL") return "Something answered on that port, but it is not PostgreSQL. Check the endpoint name and port.";
  if (/\.rds\.amazonaws\.com$/.test(hostname) && !roots.providers.rds) {
    return "This copy of Polynovea CMS is missing Amazon RDS's signing roots, so it can't verify the database. Update Polynovea CMS, then try again.";
  }
  if (code === "ERR_TLS_CERT_ALTNAME_INVALID") {
    return "The database's identity doesn't match the name you entered. Use the endpoint name exactly as your cloud console shows it, not a custom DNS name or alias.";
  }
  if (code === "CERT_HAS_EXPIRED") return "The database's TLS identity has expired. Renew it in your cloud console, then try again.";
  return isManagedDatabaseHostname(hostname)
    ? "We couldn't verify the database's identity against Amazon's or Microsoft's published roots. Check the endpoint name; on RDS, make sure the instance uses a current AWS CA (rds-ca-rsa2048-g1 or newer)."
    : "We couldn't verify the database's identity. This option supports Amazon RDS and Azure Database for PostgreSQL, whose identities are signed by roots we ship.";
}

export function loginFix(error: unknown): string {
  const code = error && typeof error === "object" && typeof (error as { code?: unknown }).code === "string" ? (error as { code: string }).code : "";
  switch (code) {
    case "28P01":
      return "The admin username or password was not accepted. Copy them again from your cloud console (the master or administrator login).";
    case "28000":
      return "The database refused a login from this server. Allow this server in the database's access rules (on a self-managed server, pg_hba.conf), then try again.";
    case "3D000":
      return "There is no database with that name on the server. Create it first, or use the database name your cloud console shows (often \"postgres\").";
    case "53300":
    case "57P03":
      return "The database is busy or still starting. Wait a minute, then try again.";
    default:
      return "Signing in to the database failed. Check the admin username and password, then try again.";
  }
}

export const CANNOT_CREATE_ROLES =
  "This login can't create database users. Use the admin (master) login your cloud created with the database, or give this login the CREATEROLE right.";

export function versionFix(major: number | null): string {
  return major === null
    ? "We couldn't read the database's PostgreSQL version. Polynovea CMS needs PostgreSQL 15 or later."
    : `This database runs PostgreSQL ${major}. Polynovea CMS needs version 15 or later: upgrade it in your cloud console, then try again.`;
}

/** server_version_num is untrusted: accept only a plain number of the expected size. */
export function parseServerVersionNum(value: unknown): number | null {
  if (typeof value !== "string" || !/^\d{5,6}$/.test(value)) return null;
  return Number(value);
}

export const MINIMUM_SERVER_VERSION_NUM = 150000;

/** True when the admin login may create roles: CREATEROLE, superuser, or the managed-admin role. */
export async function canCreateRoles(client: pg.Client): Promise<boolean> {
  const { rows } = await client.query<{ can: boolean }>(`
    select coalesce(r.rolsuper or r.rolcreaterole, false)
        or exists (
          select 1 from pg_catalog.pg_roles g
          where g.rolname in ('rds_superuser', 'azure_pg_admin') and pg_catalog.pg_has_role(current_user, g.oid, 'MEMBER')
        ) as can
    from pg_catalog.pg_roles r where r.rolname = current_user`);
  return rows[0]?.can === true;
}

// ---------------------------------------------------------------------------------------------------

export interface CheckContext {
  emit: (event: CheckEvent) => void;
  /** POLYNOVEA_SETUP_DB_ALLOWLIST, from the environment only. */
  allowlist?: string | DatabaseAllowlist;
  roots?: TrustedRoots;
  resolve?: Resolver;
  tcp?: TcpProbe;
  tls?: TlsProbe;
  factory?: ClientFactory;
}

export interface PassedChecks {
  target: DatabaseTarget;
  endpoint: Extract<DatabaseEndpoint, { kind: "remote" }>;
  /** Signed in as the admin login, password already dropped from the client. The caller ends it. */
  adminClient: pg.Client;
  serverVersionNum: number;
}

/**
 * Runs the five checks in order, emitting one running and one passed/failed event per check, and
 * stops at the first failure with a DatabaseSetupError holding the plain fix. On success the admin
 * login stays open for provisioning, so the password is needed exactly once.
 */
export async function runDatabaseChecks(input: ManagedDatabaseInput, context: CheckContext): Promise<PassedChecks> {
  const secrets = [input.password];
  const label = (id: CheckId) => CHECKS.find((check) => check.id === id)!.label;
  const step = async <T>(id: CheckId, run: () => Promise<T>, fix: (error: unknown) => string): Promise<T> => {
    context.emit({ type: "check", id, label: label(id), status: "running" });
    try {
      const result = await run();
      context.emit({ type: "check", id, label: label(id), status: "passed" });
      return result;
    } catch (error) {
      const failure = error instanceof DatabaseSetupError ? error : setupFailure(`check ${id}`, fix(error), error, secrets);
      context.emit({ type: "check", id, label: label(id), status: "failed", message: failure.message });
      throw failure;
    }
  };

  const target = await step("dns", () => resolveDatabaseTarget(input.hostname, input.port, { allowlist: context.allowlist, resolve: context.resolve }), dnsFix);
  await step("tcp", () => (context.tcp ?? tcpProbe)(target.address, target.port, 5_000), (error) => tcpFix(error, target.port));

  const roots = context.roots ?? managedDatabaseRoots();
  const endpoint = remoteEndpoint(target, roots) as Extract<DatabaseEndpoint, { kind: "remote" }>;
  await step("tls", () => (context.tls ?? tlsProbe)(endpoint, 10_000), (error) => tlsFix(error, target.hostname, roots));

  const adminClient = await step("login", async () => {
    const client = await openClient(endpoint, input.database, { user: input.user, password: input.password }, { connectTimeoutMs: 10_000, statementTimeoutMs: 30_000, factory: context.factory });
    try {
      if (!(await canCreateRoles(client))) throw new DatabaseSetupError(CANNOT_CREATE_ROLES, "check login");
    } catch (error) {
      await client.end().catch(() => {});
      throw error;
    }
    return client;
  }, loginFix);

  try {
    const serverVersionNum = await step("version", async () => {
      const { rows } = await adminClient.query<{ v: unknown }>("select current_setting('server_version_num') as v");
      const version = parseServerVersionNum(rows[0]?.v);
      if (version === null || version < MINIMUM_SERVER_VERSION_NUM) {
        throw new DatabaseSetupError(versionFix(version === null ? null : Math.floor(version / 10000)), "check version");
      }
      return version;
    }, () => versionFix(null));
    return { target, endpoint, adminClient, serverVersionNum };
  } catch (error) {
    await adminClient.end().catch(() => {});
    throw error;
  }
}
