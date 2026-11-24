/**
 * The ONE loader of "what this token sees" for generated documents: /api/v1/openapi.json and the typed
 * SDK's /api/v1/types.ts both call it, so the two always describe the same models and fields.
 */
import { getDb } from "@/lib/db/index";
import type { DeveloperApiContext } from "@/lib/developer/apiAuth";
import type { OpenApiModelInput } from "@/lib/developer/items/openapi";
import { principalForToken } from "@/lib/developer/items/principal";
import { accessibleModels } from "@/lib/developer/items/service";
import { workspaceSchemaHash } from "@/lib/developer/items/openapiHash";

export { workspaceSchemaHash };

/** The models (readable fields, writable fields, operations) this token may see, plus their combined hash. */
export async function loadItemsOpenApiInputs(ctx: DeveloperApiContext): Promise<{ models: OpenApiModelInput[]; schemaHash: string }> {
  const principal = await principalForToken(getDb(), ctx);
  const visible = await accessibleModels({ principal, callerId: ctx.tokenId, actorAdminUserId: ctx.actorAdminUserId, drafts: { allowed: false, entryIds: null } });
  const models: OpenApiModelInput[] = visible.map(({ model, access, name }) => ({
    apiKey: model.apiKey, name, schema: model.schema, schemaHash: model.schemaHash,
    readable: access.readable, writable: access.writable, canWrite: access.canWrite, canDelete: access.canDelete,
  }));
  return { models, schemaHash: workspaceSchemaHash(models) };
}
