/**
 * GET /api/v1/types.ts: the caller's TypeScript types file. Same auth as /api/v1/openapi.json
 * (`schema.read`), built from the same per-caller inputs, so it never names a field the caller cannot
 * read. The handler is a factory so it can be tested without a database.
 */
import type { DeveloperApiContext } from "@/lib/developer/apiAuth";
import { apiError } from "@/lib/developer/apiContract";
import { buildItemsOpenApi, type OpenApiModelInput } from "@/lib/developer/items/openapi";
import { SCHEMA_HASH_HEADER } from "@/lib/developer/items/types";
import { emitItemsTypes } from "@/lib/developer/sdkTypes/emit";

export type ItemsOpenApiLoader = (ctx: DeveloperApiContext) => Promise<{ models: OpenApiModelInput[]; schemaHash: string }>;

export interface TypesHandlerDeps {
  auth: (req: Request) => Promise<{ data?: DeveloperApiContext; error?: Response }>;
  load: ItemsOpenApiLoader;
  /** Clock for the generated-at header line (tests). */
  now?: () => Date;
}

/** Per caller, never cached by a shared cache, never sniffed as script. */
export const TYPES_RESPONSE_HEADERS = {
  "content-type": "text/plain; charset=utf-8",
  "cache-control": "private, no-store",
  vary: "Authorization",
  "x-content-type-options": "nosniff",
} as const;

export function createTypesHandler(deps: TypesHandlerDeps) {
  return async function GET(req: Request): Promise<Response> {
    const auth = await deps.auth(req);
    if (auth.error) return auth.error;
    const ctx = auth.data!;
    let body: string;
    let schemaHash: string;
    try {
      const input = await deps.load(ctx);
      schemaHash = input.schemaHash;
      body = emitItemsTypes(buildItemsOpenApi(input.models), { schemaHash, generatedAt: (deps.now?.() ?? new Date()).toISOString() });
    } catch {
      return apiError("TYPES_BUILD_FAILED", "The types file could not be generated", 500, { requestId: ctx.requestId, rateLimit: ctx.rateLimit });
    }
    const headers = new Headers(TYPES_RESPONSE_HEADERS);
    headers.set(SCHEMA_HASH_HEADER, schemaHash);
    headers.set("x-request-id", ctx.requestId);
    headers.set("x-ratelimit-limit", String(ctx.rateLimit.limit));
    headers.set("x-ratelimit-remaining", String(ctx.rateLimit.remaining));
    headers.set("x-ratelimit-reset", ctx.rateLimit.resetAt);
    return new Response(body, { status: 200, headers });
  };
}
