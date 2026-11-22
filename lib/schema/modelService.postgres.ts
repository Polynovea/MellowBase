// Direct PostgreSQL implementation of the schema area's database primitives (phase 1, wave 1).
//
// Same signatures and return shapes as modelService.supabase.ts; the validate → diff → apply rules
// in modelService.ts are shared. Differences that are deliberate:
// - Errors no longer leak database text. The Supabase path returned PostgREST's message as the
//   result's `error`, which the routes send to the browser. Here a function's own `raise exception`
//   text passes through (as it did), a unique violation becomes a fixed conflict message (409), and
//   anything else becomes a generic message with a reference ID that is logged server-side.
// - Rebuilding content_fields (delete, then insert) is one transaction.
// - Malformed IDs in reads are "not found"; list queries have explicit limits. listVersions and
//   getVersion take no workspace, as before: callers pass a model already read with getModel, which
//   is workspace-scoped.
import { callFunction, DEFAULT_LIST_LIMIT, expectOne, getDb, maybeOne, SqlFunctionError, withTransaction } from "@/lib/db/index";
import { clientErrorMessage } from "@/lib/http/clientError";
import type { CanonicalSchema } from "@/lib/schema/fields/types";
import { contentFieldRows, type ContentModelRow, type ContentModelVersionRow, type ServiceResult } from "@/lib/schema/modelService";

const LIST_LIMIT = DEFAULT_LIST_LIMIT;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (value: string) => UUID.test(value);

const asModel = (row: unknown) => row as ContentModelRow;
const asVersion = (row: unknown) => row as ContentModelVersionRow;

function safeFailure(error: unknown, fallback: string): { error: string; conflict: boolean } {
  if (error instanceof SqlFunctionError) return { error: error.message, conflict: /already exists/i.test(error.message) };
  const pgError = error as { code?: unknown; constraint?: unknown; message?: unknown };
  if (pgError?.code === "23505") {
    // cms_create_content_model raises its own message with SQLSTATE 23505 (no constraint name); a
    // real constraint violation names the constraint and its text stays server-side.
    const raisedByFunction = !pgError.constraint && typeof pgError.message === "string" && /^A content model with apiKey ".*" already exists in this workspace$/.test(pgError.message);
    return { error: raisedByFunction ? pgError.message as string : "A content model with this API key already exists", conflict: true };
  }
  return { error: clientErrorMessage(error, fallback), conflict: false };
}

export async function createModelRecord(args: {
  workspaceId: string;
  actorId: string;
  schema: CanonicalSchema;
  description: string | null;
  icon: string | null;
  hash: string;
  capability: string;
}): Promise<ServiceResult<{ model: ContentModelRow; version: ContentModelVersionRow }>> {
  try {
    const result = await callFunction("cms_create_content_model", {
      p_workspace_id: args.workspaceId,
      p_actor_id: args.actorId,
      p_name: args.schema.name,
      p_api_key: args.schema.apiKey,
      p_description: args.description,
      p_icon: args.icon,
      p_schema_json: JSON.stringify(args.schema),
      p_schema_hash: args.hash,
      p_capability: args.capability,
    });
    if (!result) return { ok: false, error: "Failed to create content model", status: 500 };
    return { ok: true, data: result as unknown as { model: ContentModelRow; version: ContentModelVersionRow } };
  } catch (error) {
    const failure = safeFailure(error, "Failed to create content model");
    return { ok: false, error: failure.error, status: failure.conflict ? 409 : 500 };
  }
}

export async function applySchemaVersion(args: {
  model: ContentModelRow;
  actorId: string;
  schema: CanonicalSchema;
  hash: string;
  changeSummary: string | null;
  capability: string;
}): Promise<{ ok: true; version: ContentModelVersionRow } | { ok: false; error: string }> {
  try {
    const result = await callFunction("cms_apply_model_schema_version", {
      p_workspace_id: args.model.workspace_id,
      p_actor_id: args.actorId,
      p_model_id: args.model.id,
      p_schema_json: JSON.stringify(args.schema),
      p_schema_hash: args.hash,
      p_change_summary: args.changeSummary,
      p_capability: args.capability,
    });
    if (!result) return { ok: false, error: "Failed to apply schema version" };
    return { ok: true, version: (result as unknown as { version: ContentModelVersionRow }).version };
  } catch (error) {
    return { ok: false, error: safeFailure(error, "Failed to apply schema version").error };
  }
}

export async function rebuildContentFields(contentModelId: string, schema: CanonicalSchema): Promise<void> {
  await withTransaction(async (trx) => {
    await trx.deleteFrom("content_fields").where("content_model_id", "=", contentModelId).execute();
    if (schema.fields.length === 0) return;
    await trx
      .insertInto("content_fields")
      .values(contentFieldRows(contentModelId, schema).map((row) => ({ ...row, configuration_json: JSON.stringify(row.configuration_json) })))
      .execute();
  });
}

export async function getModel(workspaceId: string, modelId: string): Promise<ContentModelRow | null> {
  if (!isUuid(modelId)) return null;
  const row = maybeOne(await getDb()
    .selectFrom("content_models")
    .selectAll()
    .where("workspace_id", "=", workspaceId)
    .where("id", "=", modelId)
    .execute());
  return row ? asModel(row) : null;
}

export async function listModels(workspaceId: string): Promise<ContentModelRow[]> {
  // One query: each model with its current version's schema (the Supabase path loaded every version
  // of every model and matched them in memory).
  const rows = await getDb()
    .selectFrom("content_models as m")
    .leftJoin("content_model_versions as v", (join) => join.onRef("v.content_model_id", "=", "m.id").onRef("v.version_number", "=", "m.current_schema_version"))
    .selectAll("m")
    .select("v.schema_json as current_schema")
    .where("m.workspace_id", "=", workspaceId)
    .orderBy("m.created_at", "desc")
    .limit(LIST_LIMIT)
    .execute();
  return rows.map((row) => ({ ...asModel(row), current_schema: (row.current_schema ?? null) as CanonicalSchema | null }));
}

export async function listVersions(modelId: string): Promise<ContentModelVersionRow[]> {
  if (!isUuid(modelId)) return [];
  const rows = await getDb()
    .selectFrom("content_model_versions")
    .selectAll()
    .where("content_model_id", "=", modelId)
    .orderBy("version_number", "desc")
    .limit(LIST_LIMIT)
    .execute();
  return rows.map(asVersion);
}

export async function getVersion(modelId: string, versionNumber: number): Promise<ContentModelVersionRow | null> {
  if (!isUuid(modelId) || !Number.isInteger(versionNumber)) return null;
  const row = maybeOne(await getDb()
    .selectFrom("content_model_versions")
    .selectAll()
    .where("content_model_id", "=", modelId)
    .where("version_number", "=", versionNumber)
    .execute());
  return row ? asVersion(row) : null;
}

export async function updateModelMetadata(
  workspaceId: string,
  modelId: string,
  patch: { description?: string; icon?: string; status?: string; updated_at: string },
): Promise<ContentModelRow> {
  return asModel(expectOne(await getDb()
    .updateTable("content_models")
    .set(patch)
    .where("workspace_id", "=", workspaceId)
    .where("id", "=", modelId)
    .returningAll()
    .execute(), "Content model not found"));
}
