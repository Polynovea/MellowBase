import type { LookupAddress } from "node:dns";
import type { Agent as HttpAgent } from "node:http";
import type { Agent as HttpsAgent } from "node:https";

export interface GuardOptions { allowPrivate?: boolean }
export type Resolver = (hostname: string, callback: (error: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void) => void;
export type LookupCallback = (error: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

export function isBlockedAddress(address: string): boolean;
export class BlockedDestinationError extends Error {
  readonly status: 403;
  readonly code: "EBLOCKEDDESTINATION";
  constructor(message?: string);
}
export function createGuardedLookup(options?: GuardOptions & { resolve?: Resolver }): (hostname: string, options: { all?: boolean } | number | undefined, callback: LookupCallback) => void;
export function guardedFetch(input: string | URL, init?: RequestInit, options?: GuardOptions): Promise<Response>;
export function guardedFetchFor(options?: GuardOptions): typeof fetch;
export function guardedHttpsAgent(options?: GuardOptions): HttpsAgent;
export function guardedS3RequestHandler(options?: GuardOptions): { httpsAgent: HttpsAgent; httpAgent: HttpAgent };

export function isAlwaysBlockedAddress(address: string): boolean;
export function embeddedIPv4(address: string): string | null;

export type DatabaseTargetReason = "invalid-port" | "invalid-host" | "localhost" | "blocked-address" | "ip-literal" | "private-not-allowed" | "not-found" | "dns-timeout";
export class DatabaseTargetError extends Error {
  readonly reason: DatabaseTargetReason;
  readonly status: 422;
  readonly code: "EDBTARGET";
  constructor(reason: DatabaseTargetReason, message: string);
}
export interface DatabaseAllowlist {
  readonly hostnames: ReadonlySet<string>;
  readonly networks: import("node:net").BlockList;
  readonly entries: readonly string[];
}
export interface DatabaseTarget {
  /** Normalised hostname (or the IP literal); TLS verifies the server against this name. */
  hostname: string;
  /** The pinned address: every connection goes to exactly this IP. */
  address: string;
  family: 4 | 6;
  port: number;
  addresses: string[];
  allowedBy: "public" | "managed-database" | "allowlist";
}
export function normalizeDatabaseHostname(hostname: string): string;
export function isManagedDatabaseHostname(hostname: string): boolean;
export function parseDatabaseAllowlist(text: string | undefined): DatabaseAllowlist;
export function resolveDatabaseTarget(
  hostname: string,
  port: number,
  options?: { allowlist?: string | DatabaseAllowlist; resolve?: Resolver },
): Promise<DatabaseTarget>;
