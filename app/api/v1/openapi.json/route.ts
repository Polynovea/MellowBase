import { apiError } from "@/lib/developer/apiContract";
import { requireDeveloperApi } from "@/lib/developer/apiAuth";
import { buildWorkspaceOpenApi } from "@/lib/developer/openapiService";
import { getDb } from "@/lib/db/index";
import { PRIVATE_HEADERS } from "@/lib/developer/items/http";
import { principalForToken } from "@/lib/developer/items/principal";
import { accessibleModels } from "@/lib/developer/items/service";

export const dynamic = "force-dynamic";

/**
 * The OpenAPI document for THIS token: only the models and fields it can read (so a hidden field's
 * name never appears), with the generated items API. Per caller, so it is never stored by a shared
 * cache: Cache-Control private, no-store and Vary: Authorization.
 */
export async function GET(req: Request) {
  const auth = await requireDeveloperApi(req, { scope: "schema.read" });
  if (auth.error) return auth.error;
  const ctx = auth.data!;
  try {
    const principal = await principalForToken(getDb(), ctx);
    const models = await accessibleModels({ principal, callerId: ctx.tokenId, actorAdminUserId: ctx.actorAdminUserId, drafts: { allowed: false, entryIds: null } });
    const document = await buildWorkspaceOpenApi(ctx.workspaceId, new URL(req.url).origin, {
      items: models.map(({ model, access, name }) => ({
        apiKey: model.apiKey, name, schema: model.schema, schemaHash: model.schemaHash,
        readable: access.readable, writable: access.writable, canWrite: access.canWrite, canDelete: access.canDelete,
      })),
    });
    const headers = new Headers({ "content-type": "application/json", "x-request-id": ctx.requestId, ...PRIVATE_HEADERS });
    headers.set("x-ratelimit-limit", String(ctx.rateLimit.limit));
    headers.set("x-ratelimit-remaining", String(ctx.rateLimit.remaining));
    headers.set("x-ratelimit-reset", ctx.rateLimit.resetAt);
    return new Response(JSON.stringify({ data: document, meta: { requestId: ctx.requestId, timestamp: new Date().toISOString(), rateLimit: ctx.rateLimit } }), { status: 200, headers });
  } catch {
    const error = apiError("OPENAPI_BUILD_FAILED", "OpenAPI document could not be generated", 500, { requestId: ctx.requestId, rateLimit: ctx.rateLimit });
    error.headers.set("cache-control", "private, no-store");
    return error;
  }
}
