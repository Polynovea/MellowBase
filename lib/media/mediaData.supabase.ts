// Supabase path of the media area's database primitives for assets, replacement, the upload quota
// and storage resolution (deleted with the switch at the end of phase 1). The queries are moved
// unchanged from assetService.ts, replacementService.ts, uploadLimits.ts and storageProvider.ts;
// the upload, validation and storage logic stays in those files and is shared by both paths.
import { createServiceRoleClient } from "@/lib/admin/serviceRole";
import { logPlatformEvent, type PlatformAuditPayload } from "@/lib/platform/audit";
import type { AssetRow } from "@/lib/media/assetService";
import type { AssetReplacementRow } from "@/lib/media/replacementService";
import type { EnvironmentRow, NewAssetRow, ReplaceAssetFileArgs, StorageConnectionRow } from "@/lib/media/mediaData";

// A malformed ID is "not found" (PostgREST reported it as an error), as on the direct path.
const isUuid = (value: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

export async function listActiveAssets(workspaceId: string): Promise<AssetRow[]> {
  const { data } = await createServiceRoleClient().from("assets").select("*").eq("workspace_id", workspaceId).is("archived_at", null).order("created_at", { ascending: false });
  return data ?? [];
}

export async function findActiveAssetByChecksum(workspaceId: string, checksum: string): Promise<AssetRow | null> {
  const { data } = await createServiceRoleClient().from("assets").select("*").eq("workspace_id", workspaceId).eq("checksum", checksum).is("archived_at", null).maybeSingle();
  return data ?? null;
}

/** Inserts the asset row, then records the audit event. */
export async function insertAsset(row: NewAssetRow, audit: (asset: AssetRow) => PlatformAuditPayload): Promise<{ ok: true; asset: AssetRow } | { ok: false; error: string }> {
  const { data: asset, error } = await createServiceRoleClient().from("assets").insert(row).select().single();
  if (error || !asset) return { ok: false, error: error?.message || "Could not register asset" };
  await logPlatformEvent(audit(asset));
  return { ok: true, asset };
}

export async function findAsset(workspaceId: string, assetId: string): Promise<AssetRow | null> {
  const { data } = await createServiceRoleClient().from("assets").select("*").eq("workspace_id", workspaceId).eq("id", assetId).maybeSingle();
  return data ?? null;
}

/** cms_replace_asset_file (history + update in one SQL transaction), then the history row it wrote. */
export async function replaceAssetFile(args: ReplaceAssetFileArgs): Promise<{ ok: true; asset: AssetRow; replacement: AssetReplacementRow } | { ok: false; error: string }> {
  const db = createServiceRoleClient();
  const { data: rpcRes, error: rpcErr } = await db.rpc("cms_replace_asset_file", {
    p_workspace_id: args.workspaceId,
    p_actor_id: args.actorId,
    p_asset_id: args.assetId,
    p_new_storage_provider: args.storageProvider,
    p_new_storage_key: args.storageKey,
    p_new_checksum: args.checksum,
    p_new_filename: args.filename,
    p_new_mime_type: args.mimeType,
    p_new_size_bytes: args.sizeBytes,
    p_new_width: args.width,
    p_new_height: args.height,
    p_reason: args.reason,
  });
  if (rpcErr || !rpcRes) return { ok: false, error: rpcErr?.message || "Could not replace asset in database" };

  const resultData = rpcRes as { asset: AssetRow; historyId: string };
  const { data: replacementRow } = await db.from("asset_replacement_history").select("*").eq("id", resultData.historyId).single();
  return { ok: true, asset: resultData.asset, replacement: replacementRow as AssetReplacementRow };
}

export async function listAssetReplacements(workspaceId: string, assetId: string): Promise<AssetReplacementRow[]> {
  const { data } = await createServiceRoleClient()
    .from("asset_replacement_history")
    .select("*")
    .eq("workspace_id", workspaceId)
    .eq("asset_id", assetId)
    .order("created_at", { ascending: false });
  return (data as AssetReplacementRow[]) ?? [];
}

/** Bytes used by the workspace's active assets (for the upload quota). */
export async function activeAssetBytes(workspaceId: string): Promise<number> {
  const { data, error } = await createServiceRoleClient().from("assets").select("size_bytes").eq("workspace_id", workspaceId).is("archived_at", null);
  if (error) throw error;
  return (data ?? []).reduce((sum: number, row: { size_bytes: number | string }) => sum + Number(row.size_bytes || 0), 0);
}

export async function environmentKind(workspaceId: string, environmentId: string): Promise<string | null> {
  if (!isUuid(environmentId)) return null;
  const { data: environment, error: environmentError } = await createServiceRoleClient().from("workspace_environments").select("kind").eq("workspace_id", workspaceId).eq("id", environmentId).maybeSingle();
  if (environmentError) throw new Error(environmentError.message);
  return environment?.kind ?? null;
}

export async function exactStorageConnection(workspaceId: string, id: string): Promise<StorageConnectionRow | null> {
  if (!isUuid(id)) return null;
  const { data, error } = await createServiceRoleClient().from("workspace_connections").select("*")
    .eq("workspace_id", workspaceId).eq("id", id).eq("connector_family", "storage").maybeSingle();
  if (error) throw new Error(error.message);
  return data as StorageConnectionRow | null;
}

export async function findEnvironment(workspaceId: string, environmentId: string): Promise<EnvironmentRow | null> {
  if (!isUuid(environmentId)) return null;
  const { data, error } = await createServiceRoleClient().from("workspace_environments").select("id,storage_provider,is_default,status,kind")
    .eq("workspace_id", workspaceId).eq("id", environmentId).maybeSingle();
  if (error) throw new Error(error.message);
  return data as EnvironmentRow | null;
}

export async function defaultEnvironment(workspaceId: string): Promise<EnvironmentRow | null> {
  const { data, error } = await createServiceRoleClient().from("workspace_environments").select("id,storage_provider,is_default,status,kind")
    .eq("workspace_id", workspaceId).order("is_default", { ascending: false }).order("created_at", { ascending: true }).limit(1).maybeSingle();
  if (error) throw new Error(error.message);
  return data as EnvironmentRow | null;
}

/** Active, verified storage connections, most recently successful first. */
export async function activeStorageConnections(workspaceId: string, environmentId: string | null): Promise<StorageConnectionRow[]> {
  let query = createServiceRoleClient().from("workspace_connections").select("*")
    .eq("workspace_id", workspaceId).eq("connector_family", "storage").eq("active", true).eq("status", "active")
    .order("last_success_at", { ascending: false, nullsFirst: false }).order("created_at", { ascending: false });
  if (environmentId) query = query.eq("environment_id", environmentId);
  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return (data ?? []) as StorageConnectionRow[];
}
