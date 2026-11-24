/**
 * The pre-phase-4 developer routes (/api/v1/content/**, /api/v1/entries/**, which the MCP server
 * calls) through the same permission function as the items API: their responses are sanitised, and
 * their writes accept only writable fields while keeping every other stored field.
 */
import type { Kysely } from "kysely";
import type { DB } from "@/lib/db/generated/database";
import { getDb } from "@/lib/db/index";
import type { DeveloperApiContext } from "@/lib/developer/apiAuth";
import { resolveModelAccesses, sanitise, type ModelAccess } from "@/lib/developer/items/access";
import { ItemsApiError } from "@/lib/developer/items/errors";
import { loadModelRefs } from "@/lib/developer/items/models";
import { principalForToken } from "@/lib/developer/items/principal";

export interface TokenAccesses {
  byId: Map<string, ModelAccess>;
  byKey: Map<string, ModelAccess>;
}

/** The token's access to the given models (by api key), or to every active model when none are given. */
export async function tokenAccesses(api: DeveloperApiContext, apiKeys?: readonly string[], db: Kysely<DB> = getDb(), options: { fieldView?: boolean } = {}): Promise<TokenAccesses> {
  const keys = apiKeys ?? (await db.selectFrom("content_models").select("api_key").where("workspace_id", "=", api.workspaceId).where("status", "=", "active").limit(500).execute()).map((row) => row.api_key);
  const base = await principalForToken(db, api);
  // fieldView: which fields the token may SEE in schema documents (schema.read), decided by the same
  // field rules; it never grants content reads. A fail-closed principal (no scopes) stays closed.
  const principal = options.fieldView && base.scopes.size ? { ...base, scopes: new Set([...base.scopes, "content.read"]) } : base;
  const models = await loadModelRefs(db, api.workspaceId, keys);
  const byKey = await resolveModelAccesses(principal, models, db);
  return { byKey, byId: new Map([...byKey.values()].map((access) => [access.model.id, access])) };
}

const isPlain = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Walks a response payload and sanitises every `data_jsonb` / `data` object of an entry, version or
 * record, using the model of the nearest entry (content_model_id), entry view (model.id) or published
 * record (model api key). Data whose model is unknown or unreadable becomes {}.
 */
export function sanitiseLegacyPayload<T>(value: T, accesses: TokenAccesses, modelId: string | null = null): T {
  if (Array.isArray(value)) return value.map((item) => sanitiseLegacyPayload(item, accesses, modelId)) as T;
  if (!isPlain(value)) return value;
  const modelRef = value.model;
  const context =
    (typeof value.content_model_id === "string" ? value.content_model_id : null)
    ?? (isPlain(modelRef) && typeof modelRef.id === "string" ? modelRef.id : null)
    ?? (typeof modelRef === "string" ? accesses.byKey.get(modelRef)?.model.id ?? "unknown" : null)
    ?? (isPlain(value.entry) && typeof value.entry.content_model_id === "string" ? value.entry.content_model_id : null)
    ?? (isPlain(value.content_entries) && typeof value.content_entries.content_model_id === "string" ? value.content_entries.content_model_id : null)
    ?? modelId;
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value)) {
    if ((key === "data_jsonb" || key === "data") && isPlain(inner) && context) {
      const access = accesses.byId.get(context);
      out[key] = access ? sanitise(access, inner, "out") : {};
    } else {
      out[key] = sanitiseLegacyPayload(inner, accesses, context);
    }
  }
  return out as T;
}

/**
 * A write's data: only writable fields (unknown or hidden → UNKNOWN_FIELD, read-only → FIELD_READ_ONLY),
 * on top of the stored fields the caller cannot write, which are kept as they are.
 */
export function legacyWriteData(access: ModelAccess, body: unknown, stored: Record<string, unknown> | null, creating: boolean): Record<string, unknown> {
  const accepted = sanitise(access, body ?? {}, "in");
  if (creating) {
    const blocked = access.model.schema.fields.filter((field) => field.required && !access.writable.has(field.key));
    if (blocked.length) throw new ItemsApiError("REQUIRED_FIELD_NOT_WRITABLE", "This model requires fields this token cannot set");
  }
  const kept = Object.fromEntries(Object.entries(stored ?? {}).filter(([key]) => !access.writable.has(key)));
  return { ...kept, ...accepted };
}

interface SchemaBundleModelLike {
  apiKey: string;
  schema: { fields: ReadonlyArray<{ key: string }> };
}

/**
 * A schema bundle as the token may see it: models it cannot read are left out, and each model's
 * fields are only the ones it can read (a hidden field's key never appears). Owners see everything.
 */
export function filterSchemaBundle<M extends SchemaBundleModelLike, T extends { models: M[] }>(bundle: T, accesses: TokenAccesses): T {
  const models = bundle.models
    .filter((model) => accesses.byKey.get(model.apiKey)?.canRead)
    .map((model) => {
      const access = accesses.byKey.get(model.apiKey)!;
      return { ...model, schema: { ...model.schema, fields: model.schema.fields.filter((field) => access.readable.has(field.key)) } } as M;
    });
  return { ...bundle, models };
}
