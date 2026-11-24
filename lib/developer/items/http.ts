/**
 * HTTP glue for the items routes: authenticate the token (requireDeveloperApi, unchanged: scopes,
 * allowed models, rate limit per token, bound agents), build the principal, resolve the preview scope,
 * run the service, and answer in the items envelope. Every response is per caller: private, never
 * stored by a shared cache, and varies by Authorization and the preview header.
 */
import { randomUUID } from "node:crypto";
import { getDb } from "@/lib/db/index";
import { requireDeveloperApi, type DeveloperApiContext } from "@/lib/developer/apiAuth";
import type { DeveloperApiScope } from "@/lib/developer/apiTokenService";
import { ItemsApiError } from "@/lib/developer/items/errors";
import { principalForToken, previewScope } from "@/lib/developer/items/principal";
import type { ItemsContext } from "@/lib/developer/items/service";
import { PREVIEW_SCOPE, PREVIEW_TOKEN_HEADER, SCHEMA_HASH_HEADER, type RateLimitMeta } from "@/lib/developer/items/types";

export const PRIVATE_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "cache-control": "private, no-store",
  vary: `Authorization, ${PREVIEW_TOKEN_HEADER}`,
});

function headers(requestId: string, rateLimit?: RateLimitMeta, schemaHash?: string): Headers {
  const h = new Headers({ "content-type": "application/json", "x-request-id": requestId, ...PRIVATE_HEADERS });
  if (rateLimit) {
    h.set("x-ratelimit-limit", String(rateLimit.limit));
    h.set("x-ratelimit-remaining", String(rateLimit.remaining));
    h.set("x-ratelimit-reset", rateLimit.resetAt);
  }
  if (schemaHash) h.set(SCHEMA_HASH_HEADER, schemaHash);
  return h;
}

export function itemsOk(body: { data: unknown; meta?: Record<string, unknown> }, ctx: { requestId: string; rateLimit?: RateLimitMeta }, schemaHash: string, status = 200): Response {
  if (status === 204) return new Response(null, { status, headers: headers(ctx.requestId, ctx.rateLimit) });
  const meta = { requestId: ctx.requestId, timestamp: new Date().toISOString(), schemaHash, ...(ctx.rateLimit ? { rateLimit: ctx.rateLimit } : {}), ...body.meta };
  return new Response(JSON.stringify({ data: body.data, meta }), { status, headers: headers(ctx.requestId, ctx.rateLimit, schemaHash) });
}

export function itemsError(error: unknown, ctx: { requestId: string; rateLimit?: RateLimitMeta }): Response {
  const known = error instanceof ItemsApiError
    ? error
    : new ItemsApiError("ITEMS_UNAVAILABLE", "Items could not be read right now");
  if (!(error instanceof ItemsApiError)) console.error("[items-api] unexpected failure", { requestId: ctx.requestId, code: (error as { code?: unknown })?.code ?? null });
  const h = headers(ctx.requestId, ctx.rateLimit);
  if (known.code === "MODEL_TABLE_NOT_READY") h.set("retry-after", "30");
  const body = { error: { code: known.code, message: known.message, ...(known.details === undefined ? {} : { details: known.details }) }, meta: { requestId: ctx.requestId, timestamp: new Date().toISOString(), ...(ctx.rateLimit ? { rateLimit: ctx.rateLimit } : {}) } };
  return new Response(JSON.stringify(body), { status: known.status, headers: h });
}

/** Adds the private-cache headers to a response produced by requireDeveloperApi. */
function privateCopy(response: Response): Response {
  const h = new Headers(response.headers);
  for (const [key, value] of Object.entries(PRIVATE_HEADERS)) h.set(key, value);
  return new Response(response.body, { status: response.status, headers: h });
}

/**
 * Authenticates and builds the items context. `scope` is the operation's token scope; drafts need a
 * preview token for this workspace (entry or release scoped) or the content.preview scope.
 */
export async function itemsRequest(req: Request, options: { scope: DeveloperApiScope; modelApiKey: string; write?: boolean }): Promise<{ ctx?: ItemsContext; api?: DeveloperApiContext; error?: Response }> {
  const auth = await requireDeveloperApi(req, { scope: options.scope, modelApiKey: options.modelApiKey, requireActor: options.write });
  if (auth.error) return { error: privateCopy(auth.error) };
  const api = auth.data!;
  try {
    const db = getDb();
    const principal = await principalForToken(db, api);
    let drafts: ItemsContext["drafts"] = { allowed: api.scopes.includes(PREVIEW_SCOPE), entryIds: null };
    const rawPreview = req.headers.get(PREVIEW_TOKEN_HEADER);
    if (rawPreview && !drafts.allowed) {
      const scope = await previewScope(db, rawPreview.trim());
      // A token of another workspace is treated exactly like an invalid one.
      if (scope && scope.workspaceId === api.workspaceId) drafts = { allowed: true, entryIds: scope.entryIds };
    }
    return { api, ctx: { principal, callerId: api.tokenId, actorAdminUserId: api.actorAdminUserId, drafts, db } };
  } catch (error) {
    return { error: itemsError(error, { requestId: api.requestId, rateLimit: api.rateLimit }) };
  }
}

export const requestIdOf = (req: Request) => req.headers.get("x-request-id")?.trim() || randomUUID();
