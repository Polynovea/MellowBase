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

/** Creates (or reuses) the built-in auth user and makes them the owner, in one transaction. */
export function bootstrapBuiltinOwner(
  client: ClientBase,
  details: OwnerDetails & { password?: string | null; pwnedLookup?: PwnedRangeFetch },
): Promise<GrantedOwner & { authUserId: string; createdUser: boolean; setPassword: boolean }>;
