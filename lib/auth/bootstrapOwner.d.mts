import type { ClientBase } from "pg";
import type { PwnedRangeFetch } from "./passwordPolicy.mjs";

export interface OwnerDetails {
  email: string;
  username: string;
  displayName: string;
  workspaceSlug: string;
}

export interface GrantedOwner {
  adminUserId: string;
  workspaceId: string;
  memberId: string;
}

/** Makes `authUserId` the active master admin and workspace owner, inside the caller's open transaction. */
export function grantOwnerRows(client: ClientBase, details: OwnerDetails & { authUserId: string }): Promise<GrantedOwner>;

export type BootstrappedOwner = GrantedOwner & { authUserId: string; createdUser: boolean; setPassword: boolean };

/**
 * Creates (or reuses) the built-in auth user and makes them the owner, inside the caller's open
 * transaction. `passwordHash` is an Argon2id hash from betterAuth/passwordHash.mjs, used in place of
 * `password` (pass one or the other).
 */
export function bootstrapBuiltinOwnerInTransaction(
  client: ClientBase,
  details: OwnerDetails & { password?: string | null; passwordHash?: string | null; pwnedLookup?: PwnedRangeFetch },
): Promise<BootstrappedOwner>;

/** Creates (or reuses) the built-in auth user and makes them the owner, in one transaction. */
export function bootstrapBuiltinOwner(
  client: ClientBase,
  details: OwnerDetails & { password?: string | null; pwnedLookup?: PwnedRangeFetch },
): Promise<BootstrappedOwner>;

/** Creates a built-in auth user (confirmed address, password checked and hashed) inside the caller's open transaction. */
export function createBuiltinUser(
  client: ClientBase,
  details: { email: string; password: string; name?: string; hasMfa?: boolean; pwnedLookup?: PwnedRangeFetch },
): Promise<{ authUserId: string; email: string }>;
