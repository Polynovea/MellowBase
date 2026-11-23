import { isIP } from "node:net";
import pg from "pg";
import type { DatabaseTarget } from "@/lib/infrastructure/guardedNetwork.mjs";
import { pinnedTlsOptions } from "@/lib/infrastructure/postgresTls.mjs";

/**
 * Where the database step connects.
 *
 * - `remote`: a managed or operator-allowed database. `address` is the IP that resolveDatabaseTarget
 *   checked and pinned; `hostname` is what TLS verifies (verify-full, against `ca` only). There is no
 *   unverified fallback: a remote endpoint without roots cannot be built.
 * - `local`: the bundled PostgreSQL on this server ("On this server"), on 127.0.0.1 or a unix socket
 *   directory. Never built from anything a browser sent.
 */
export type DatabaseEndpoint =
  | { kind: "remote"; hostname: string; address: string; port: number; ca: string[]; caBundleId: string }
  | { kind: "local"; host: string; port: number };

export interface DatabaseLogin {
  user: string;
  password: string;
}

export function remoteEndpoint(target: DatabaseTarget, roots: { id: string; ca: string[] }): DatabaseEndpoint {
  if (!isIP(target.address)) throw new Error("A remote endpoint needs the pinned IP address");
  if (roots.ca.length === 0) throw new Error("A remote endpoint needs root certificates");
  return { kind: "remote", hostname: target.hostname, address: target.address, port: target.port, ca: roots.ca, caBundleId: roots.id };
}

export function localEndpoint(host: string, port: number): DatabaseEndpoint {
  if (host !== "127.0.0.1" && !/^\/[A-Za-z0-9._/-]+$/.test(host)) throw new Error("The local database listens on 127.0.0.1 or a unix socket only");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid local database port");
  return { kind: "local", host, port };
}

export interface ClientOptions {
  /** Connect (TCP + TLS + login) timeout. */
  connectTimeoutMs?: number;
  /** Per-statement timeout; 0 for none (migrations). */
  statementTimeoutMs?: number;
}

/**
 * node-postgres settings from discrete fields: never a connection string, so nothing in a URL can
 * change the TLS settings, and the password is never embedded in a string that might be logged.
 */
export function clientConfig(endpoint: DatabaseEndpoint, database: string, login: DatabaseLogin, options: ClientOptions = {}): pg.ClientConfig {
  const common = {
    port: endpoint.port,
    database,
    user: login.user,
    password: login.password,
    application_name: "polynovea-setup",
    connectionTimeoutMillis: options.connectTimeoutMs ?? 10_000,
    ...(options.statementTimeoutMs ? { statement_timeout: options.statementTimeoutMs } : {}),
  };
  if (endpoint.kind === "local") return { ...common, host: endpoint.host, ssl: false };
  return { ...common, host: endpoint.address, ssl: pinnedTlsOptions({ servername: endpoint.hostname, ca: endpoint.ca }) };
}

export type ClientFactory = (config: pg.ClientConfig) => pg.Client;
const defaultFactory: ClientFactory = (config) => new pg.Client(config);

/**
 * Removes the password from a connected client. node-postgres keeps it on the client for the login
 * exchange only; once connected nothing reads it again, so it must not linger in memory or in any
 * object that might be inspected or logged.
 */
export function forgetPassword(client: pg.Client): void {
  const holder = client as unknown as { password?: unknown; connectionParameters?: { password?: unknown } };
  holder.password = null;
  if (holder.connectionParameters) holder.connectionParameters.password = null;
}

/** Connects, then forgets the password. The caller ends the client. */
export async function openClient(
  endpoint: DatabaseEndpoint,
  database: string,
  login: DatabaseLogin,
  options: ClientOptions & { factory?: ClientFactory } = {},
): Promise<pg.Client> {
  const client = (options.factory ?? defaultFactory)(clientConfig(endpoint, database, login, options));
  // An idle client's socket error must not crash the process; the next query reports it.
  client.on("error", () => {});
  try {
    await client.connect();
  } catch (error) {
    forgetPassword(client);
    await client.end().catch(() => {});
    throw error;
  }
  forgetPassword(client);
  return client;
}
