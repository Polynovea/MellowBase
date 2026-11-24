import { NextResponse } from "next/server";
import { requirePlatformAccess } from "@/lib/platform/permissions";
import { createDeveloperApiToken, listDeveloperApiTokens } from "@/lib/developer/apiTokenService";
import { clientErrorMessage } from "@/lib/http/clientError";
import { getDb } from "@/lib/db/index";

const respond = (success: boolean, data: unknown, error: string | null, status = 200) => NextResponse.json({ success, data, error, timestamp: new Date().toISOString() }, { status });

export async function GET(req: Request) {
  const auth = await requirePlatformAccess(req, { permission: "workspace.manage" });
  if (auth.error) return auth.error;
  try {
    return respond(true, await listDeveloperApiTokens(auth.data!.actor.workspaceId), null);
  } catch (error) {
    return respond(false, null, clientErrorMessage(error, "Could not list API tokens"), 500);
  }
}

export async function POST(req: Request) {
  const auth = await requirePlatformAccess(req, { permission: "workspace.manage", stepUp: true });
  if (auth.error) return auth.error;
  try {
    const body = await req.json();
    const roleId = typeof body.roleId === "string" && body.roleId ? body.roleId : null;
    if (roleId) {
      // A token may act only as a role its creator holds (the owner may bind any role of the
      // workspace): workspace.manage alone must not mint an owner-level token. The binding is in the
      // token's audit event (roleId).
      const role = await getDb().selectFrom("roles").select(["id", "key"]).where("id", "=", roleId).where("workspace_id", "=", auth.data!.actor.workspaceId).executeTakeFirst();
      const actorKeys = auth.data!.actor.roleKeys;
      if (!role || (!actorKeys.includes("owner") && !actorKeys.includes(role.key))) {
        return respond(false, null, "You can only give a token a role you hold yourself", 403);
      }
    }
    const result = await createDeveloperApiToken({
      workspaceId: auth.data!.actor.workspaceId,
      actorId: auth.data!.actor.adminUserId,
      name: String(body.name ?? ""),
      scopes: Array.isArray(body.scopes) ? body.scopes.map(String) : [],
      allowedModels: Array.isArray(body.allowedModels) ? body.allowedModels.map(String) : [],
      expiresAt: body.expiresAt ? String(body.expiresAt) : null,
      rateLimitPerMinute: body.rateLimitPerMinute === undefined ? undefined : Number(body.rateLimitPerMinute),
      // The database refuses a role of another workspace (composite foreign key, migration 0078).
      roleId,
    });
    return respond(true, result, null, 201);
  } catch (error) {
    return respond(false, null, clientErrorMessage(error, "Could not create API token"), 400);
  }
}
