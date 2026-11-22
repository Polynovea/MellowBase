import type { ClientBase } from "pg";

export const COMPATIBILITY_ROLES: readonly string[];
export const OWNER_ROLE: "polynovea_owner";
export const APP_ROLE: "polynovea_app";
export function missingCompatibilityRoles(client: ClientBase): Promise<string[]>;
export function ensureCompatibilityRoles(client: ClientBase): Promise<string[]>;
export function bootstrapInstallRoles(
  client: ClientBase,
  options: { database: string; ownerPassword: string; appPassword: string },
): Promise<void>;
