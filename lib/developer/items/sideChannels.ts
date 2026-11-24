/**
 * The side channels' door to the one permission function: previews, scheduled publishing, webhooks,
 * search snippets. Each builds a principal for the admin behind the channel (preview issuer, release
 * approver, webhook owner) and asks resolveModelAccesses; data leaves only through sanitise "out".
 * A channel with no active admin behind it gets nothing (fail closed).
 */
import type { Kysely } from "kysely";
import type { DB } from "@/lib/db/generated/database";
import { resolveModelAccesses, sanitise, type ModelAccess, type PrincipalKind } from "@/lib/developer/items/access";
import { principalForAdmin } from "@/lib/developer/items/principal";
import { loadModelRefs } from "@/lib/developer/items/models";

/** Access per model api key for an admin acting through a channel; null when the admin is not an active member. */
export async function adminAccesses(db: Kysely<DB>, workspaceId: string, adminUserId: string | null | undefined, kind: PrincipalKind, modelApiKeys: readonly string[], grantedScopes: readonly string[] = []): Promise<Map<string, ModelAccess> | null> {
  if (!adminUserId) return null;
  const principal = await principalForAdmin(db, workspaceId, adminUserId, kind, grantedScopes);
  if (!principal) return null;
  const models = await loadModelRefs(db, workspaceId, [...new Set(modelApiKeys)]);
  return resolveModelAccesses(principal, models, db);
}

/** Sanitises one data object for a channel; anything without an access (unknown model, no admin) is emptied. */
export function sanitiseFor(accesses: Map<string, ModelAccess> | null, modelApiKey: string | null | undefined, data: unknown): Record<string, unknown> {
  const access = modelApiKey ? accesses?.get(modelApiKey) : undefined;
  return access ? sanitise(access, data, "out") : {};
}
