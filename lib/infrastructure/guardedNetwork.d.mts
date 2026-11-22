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
