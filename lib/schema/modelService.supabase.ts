// Supabase path of the schema area's database primitives (deleted with the switch at the end of
// phase 1). The validate → diff → apply rules live in modelService.ts and are shared by both paths.
import { createServiceRoleClient } from "@/lib/admin/serviceRole";
import type { CanonicalSchema } from "@/lib/schema/fields/types";
import { contentFieldRows, type ContentModelRow, type ContentModelVersionRow, type ServiceResult } from "@/lib/schema/modelService";

export async function createModelRecord(args: {
  workspaceId: string;
  actorId: string;
  schema: CanonicalSchema;
  description: string | null;
  icon: string | null;
  hash: string;
  capability: string;
}): Promise<ServiceResult<{ model: ContentModelRow; version: ContentModelVersionRow }>> {
  const db = createServiceRoleClient();
  const { data: rpcRes, error: rpcError } = await db.rpc("cms_create_content_model", {
    p_workspace_id: args.workspaceId,
    p_actor_id: args.actorId,
    p_name: args.schema.name,
    p_api_key: args.schema.apiKey,
    p_description: args.description,
    p_icon: args.icon,
    p_schema_json: args.schema,
    p_schema_hash: args.hash,
    p_capability: args.capability,
  });

  if (rpcError || !rpcRes) {
    const isConflict = rpcError?.code === "23505" || rpcError?.message?.includes("already exists");
    return { ok: false, error: rpcError?.message ?? "Failed to create content model", status: isConflict ? 409 : 500 };
  }

  const result = rpcRes as { model: ContentModelRow; version: ContentModelVersionRow };
  return { ok: true, data: result };
}

export async function applySchemaVersion(args: {
  model: ContentModelRow;
  actorId: string;
  schema: CanonicalSchema;
  hash: string;
  changeSummary: string | null;
  capability: string;
}): Promise<{ ok: true; version: ContentModelVersionRow } | { ok: false; error: string }> {
  const { data: rpcRes, error: rpcError } = await createServiceRoleClient().rpc("cms_apply_model_schema_version", {
    p_workspace_id: args.model.workspace_id,
    p_actor_id: args.actorId,
    p_model_id: args.model.id,
    p_schema_json: args.schema,
    p_schema_hash: args.hash,
    p_change_summary: args.changeSummary,
    p_capability: args.capability,
  });
  if (rpcError || !rpcRes) return { ok: false, error: rpcError?.message ?? "Failed to apply schema version" };
  return { ok: true, version: (rpcRes as { version: ContentModelVersionRow }).version };
}

export async function rebuildContentFields(contentModelId: string, schema: CanonicalSchema): Promise<void> {
  const db = createServiceRoleClient();
  const { error: delError } = await db.from("content_fields").delete().eq("content_model_id", contentModelId);
  if (delError) throw new Error(`Failed to clear content_fields: ${delError.message}`);
  if (schema.fields.length === 0) return;

  const { error: insError } = await db.from("content_fields").insert(contentFieldRows(contentModelId, schema));
  if (insError) throw new Error(`Failed to insert content_fields: ${insError.message}`);
}

export async function getModel(workspaceId: string, modelId: string): Promise<ContentModelRow | null> {
  const db = createServiceRoleClient();
  const { data } = await db.from("content_models").select("*").eq("workspace_id", workspaceId).eq("id", modelId).maybeSingle();
  return data ?? null;
}

export async function listModels(workspaceId: string): Promise<ContentModelRow[]> {
  const db = createServiceRoleClient();
  const { data: models } = await db.from("content_models").select("*").eq("workspace_id", workspaceId).order("created_at", { ascending: false });
  if (!models || models.length === 0) return [];

  const modelIds = models.map((m) => m.id);
  const { data: versions } = await db
    .from("content_model_versions")
    .select("content_model_id, version_number, schema_json")
    .in("content_model_id", modelIds);

  const versionMap = new Map<string, CanonicalSchema>();
  for (const v of versions || []) {
    versionMap.set(`${v.content_model_id}:${v.version_number}`, v.schema_json as CanonicalSchema);
  }

  return models.map((m) => ({
    ...m,
    current_schema: versionMap.get(`${m.id}:${m.current_schema_version}`) ?? null,
  }));
}

export async function listVersions(modelId: string): Promise<ContentModelVersionRow[]> {
  const db = createServiceRoleClient();
  const { data } = await db
    .from("content_model_versions")
    .select("*")
    .eq("content_model_id", modelId)
    .order("version_number", { ascending: false });
  return data ?? [];
}

export async function getVersion(modelId: string, versionNumber: number): Promise<ContentModelVersionRow | null> {
  const db = createServiceRoleClient();
  const { data } = await db
    .from("content_model_versions")
    .select("*")
    .eq("content_model_id", modelId)
    .eq("version_number", versionNumber)
    .maybeSingle();
  return data ?? null;
}

// Moved from app/api/models/[id]/route.ts (PATCH) so the route has no direct queries.
export async function updateModelMetadata(
  workspaceId: string,
  modelId: string,
  patch: { description?: string; icon?: string; status?: string; updated_at: string },
): Promise<ContentModelRow> {
  const { data, error } = await createServiceRoleClient()
    .from("content_models")
    .update(patch)
    .eq("workspace_id", workspaceId)
    .eq("id", modelId)
    .select()
    .single();
  if (error || !data) throw error ?? new Error("Could not update content model");
  return data as ContentModelRow;
}
