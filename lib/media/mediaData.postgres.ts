// PostgreSQL implementation of the media area's database primitives (phase 1, wave 2).
//
// Deliberate differences from the Supabase path it replaced in phase 1:
// - Registering an asset writes the row and its audit event in one transaction.
// - Replacing a file runs cms_replace_asset_file and reads the history row it wrote in the same
// transaction; the function's own messages pass through, database internals do not.
// - The quota sums sizes in SQL. The Supabase path loaded one row per asset (capped at 1000 by
// PostgREST), so a large workspace's usage was undercounted and the quota could be exceeded.
// - A duplicate checksum is resolved deterministically (oldest asset first) instead of failing as
// "more than one row" and reading as "no duplicate".
// - Malformed IDs are "not found"; lists have explicit limits and id tie-breaks; every statement is
// scoped by workspace_id.
import { sql } from "kysely";
import { callFunction, DEFAULT_LIST_LIMIT, expectOne, getDb, maybeOne, SqlFunctionError, withTransaction } from "@/lib/db/index";
import { clientErrorMessage } from "@/lib/http/clientError";
import { recordPlatformEvent } from "@/lib/platform/audit.postgres";
import type { PlatformAuditPayload } from "@/lib/platform/audit";
import type { AssetRow } from "@/lib/media/assetService";
import type { AssetReplacementRow } from "@/lib/media/replacementService";
import type { EnvironmentRow, NewAssetRow, ReplaceAssetFileArgs, StorageConnectionRow } from "@/lib/media/mediaData";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (value: string) => UUID.test(value);
const asAsset = (row: unknown) => row as AssetRow;

export async function listActiveAssets(workspaceId: string): Promise<AssetRow[]> {
  const rows = await getDb().selectFrom("assets").selectAll()
    .where("workspace_id", "=", workspaceId).where("archived_at", "is", null)
    .orderBy("created_at", "desc").orderBy("id", "desc").limit(DEFAULT_LIST_LIMIT).execute();
  return rows.map(asAsset);
}

export async function findActiveAssetByChecksum(workspaceId: string, checksum: string): Promise<AssetRow | null> {
  const rows = await getDb().selectFrom("assets").selectAll()
    .where("workspace_id", "=", workspaceId).where("checksum", "=", checksum).where("archived_at", "is", null)
    .orderBy("created_at", "asc").orderBy("id", "asc").limit(1).execute();
  return rows[0] ? asAsset(rows[0]) : null;
}

export async function insertAsset(row: NewAssetRow, audit: (asset: AssetRow) => PlatformAuditPayload): Promise<{ ok: true; asset: AssetRow } | { ok: false; error: string }> {
  try {
    const asset = await withTransaction(async (trx) => {
      const inserted = asAsset(expectOne(await trx.insertInto("assets")
        .values({ ...row, metadata_json: JSON.stringify(row.metadata_json) })
        .returningAll().execute(), "Could not register asset"));
      await recordPlatformEvent(trx, audit(inserted));
      return inserted;
    });
    return { ok: true, asset };
  } catch (error) {
    return { ok: false, error: clientErrorMessage(error, "Could not register asset") };
  }
}

export async function findAsset(workspaceId: string, assetId: string): Promise<AssetRow | null> {
  if (!isUuid(assetId)) return null;
  const row = maybeOne(await getDb().selectFrom("assets").selectAll()
    .where("workspace_id", "=", workspaceId).where("id", "=", assetId).execute());
  return row ? asAsset(row) : null;
}

export async function replaceAssetFile(args: ReplaceAssetFileArgs): Promise<{ ok: true; asset: AssetRow; replacement: AssetReplacementRow } | { ok: false; error: string }> {
  try {
    return await withTransaction(async (trx) => {
      const result = await callFunction("cms_replace_asset_file", {
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
      }, trx);
      if (!result) throw new Error("Could not replace asset in database");
      const { asset, historyId } = result as unknown as { asset: AssetRow; historyId: string };
      const replacement = expectOne(await trx.selectFrom("asset_replacement_history").selectAll()
        .where("workspace_id", "=", args.workspaceId).where("id", "=", historyId).execute(), "Replacement history row not found");
      return { ok: true as const, asset, replacement: replacement as unknown as AssetReplacementRow };
    });
  } catch (error) {
    return { ok: false, error: error instanceof SqlFunctionError ? error.message : clientErrorMessage(error, "Could not replace asset in database") };
  }
}

export async function listAssetReplacements(workspaceId: string, assetId: string): Promise<AssetReplacementRow[]> {
  if (!isUuid(assetId)) return [];
  const rows = await getDb().selectFrom("asset_replacement_history").selectAll()
    .where("workspace_id", "=", workspaceId).where("asset_id", "=", assetId)
    .orderBy("created_at", "desc").orderBy("id", "desc").limit(DEFAULT_LIST_LIMIT).execute();
  return rows as unknown as AssetReplacementRow[];
}

export async function activeAssetBytes(workspaceId: string): Promise<number> {
  const row = await getDb().selectFrom("assets")
    .select(sql<string>`coalesce(sum(size_bytes), 0)`.as("used"))
    .where("workspace_id", "=", workspaceId).where("archived_at", "is", null)
    .executeTakeFirstOrThrow();
  return Number(row.used);
}

export async function environmentKind(workspaceId: string, environmentId: string): Promise<string | null> {
  if (!isUuid(environmentId)) return null;
  const row = maybeOne(await getDb().selectFrom("workspace_environments").select("kind")
    .where("workspace_id", "=", workspaceId).where("id", "=", environmentId).execute());
  return row?.kind ?? null;
}

export async function exactStorageConnection(workspaceId: string, id: string): Promise<StorageConnectionRow | null> {
  if (!isUuid(id)) return null;
  const row = maybeOne(await getDb().selectFrom("workspace_connections").selectAll()
    .where("workspace_id", "=", workspaceId).where("id", "=", id).where("connector_family", "=", "storage").execute());
  return (row ?? null) as unknown as StorageConnectionRow | null;
}

export async function findEnvironment(workspaceId: string, environmentId: string): Promise<EnvironmentRow | null> {
  if (!isUuid(environmentId)) return null;
  const row = maybeOne(await getDb().selectFrom("workspace_environments").select(["id", "storage_provider", "is_default", "status", "kind"])
    .where("workspace_id", "=", workspaceId).where("id", "=", environmentId).execute());
  return (row ?? null) as EnvironmentRow | null;
}

export async function defaultEnvironment(workspaceId: string): Promise<EnvironmentRow | null> {
  const rows = await getDb().selectFrom("workspace_environments").select(["id", "storage_provider", "is_default", "status", "kind"])
    .where("workspace_id", "=", workspaceId)
    .orderBy("is_default", "desc").orderBy("created_at", "asc").orderBy("id", "asc").limit(1).execute();
  return (rows[0] ?? null) as EnvironmentRow | null;
}

export async function activeStorageConnections(workspaceId: string, environmentId: string | null): Promise<StorageConnectionRow[]> {
  if (environmentId && !isUuid(environmentId)) return [];
  let query = getDb().selectFrom("workspace_connections").selectAll()
    .where("workspace_id", "=", workspaceId).where("connector_family", "=", "storage")
    .where("active", "=", true).where("status", "=", "active");
  if (environmentId) query = query.where("environment_id", "=", environmentId);
  const rows = await query
    .orderBy("last_success_at", (ob) => ob.desc().nullsLast()).orderBy("created_at", "desc").orderBy("id", "desc")
    .limit(DEFAULT_LIST_LIMIT).execute();
  return rows as unknown as StorageConnectionRow[];
}
