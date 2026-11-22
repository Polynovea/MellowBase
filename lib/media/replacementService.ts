import { createHash } from "node:crypto";
import { findAsset, listAssetReplacements as listReplacementRows, replaceAssetFile } from "@/lib/media/mediaData";
import { getStorageProvider } from "@/lib/media/storageProvider";
import type { AssetRow, AssetResult } from "@/lib/media/assetService";

export interface AssetReplacementRow {
  id: string;
  workspace_id: string;
  asset_id: string;
  old_storage_provider: string;
  old_storage_key: string;
  old_checksum: string;
  old_filename: string;
  old_mime_type: string;
  old_size_bytes: number;
  old_width: number | null;
  old_height: number | null;
  new_storage_provider: string;
  new_storage_key: string;
  new_checksum: string;
  new_filename: string;
  new_mime_type: string;
  new_size_bytes: number;
  new_width: number | null;
  new_height: number | null;
  reason: string | null;
  replaced_by: string | null;
  created_at: string;
}

const ALLOWED_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/svg+xml",
  "video/mp4",
  "video/webm",
  "application/pdf",
]);
const MAX_SIZE = 20 * 1024 * 1024;

function safeSegment(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "file";
}

/**
 * Recoverable In-Place Media Replacement:
 * 1. Uploads to a NEW storage key.
 * 2. Validates checksum, type, and size.
 * 3. Records complete previous state in asset_replacement_history.
 * 4. Updates assets table row retaining stable asset_id.
 * 5. Old blob is retained on storage according to retention policy.
 */
import { extractDimensions } from "@/lib/media/dimensionParser";

export async function replaceAsset(params: {
  workspaceId: string;
  actorAdminUserId: string;
  assetId: string;
  file: File;
  environmentId?: string | null;
  reason?: string;
}): Promise<AssetResult<{ asset: AssetRow; replacement: AssetReplacementRow }>> {
  if (!ALLOWED_TYPES.has(params.file.type)) {
    return { ok: false, error: `Unsupported file type: ${params.file.type}`, status: 415 };
  }
  if (params.file.size > MAX_SIZE) {
    return { ok: false, error: "Asset exceeds 20 MB limit", status: 413 };
  }

  const currentAsset = await findAsset(params.workspaceId, params.assetId);

  if (!currentAsset) {
    return { ok: false, error: "Asset not found in workspace", status: 404 };
  }

  const body = Buffer.from(await params.file.arrayBuffer());
  const newChecksum = createHash("sha256").update(body).digest("hex");
  const filename = safeSegment(params.file.name);
  const folder = currentAsset.folder || "general";
  const newStorageKey = `${params.workspaceId}/${folder}/${Date.now()}-${newChecksum.slice(0, 12)}-${filename}`;

  const dimensions = extractDimensions(body, params.file.type);

  const provider = await getStorageProvider({
    workspaceId: params.workspaceId,
    environmentId: params.environmentId,
    storageProviderKey: params.environmentId ? null : currentAsset.storage_provider,
  });
  await provider.upload({ body, key: newStorageKey, contentType: params.file.type });

  // 1 & 2: record history and update the asset atomically (cms_replace_asset_file).
  const replaced = await replaceAssetFile({
    workspaceId: params.workspaceId,
    actorId: params.actorAdminUserId,
    assetId: currentAsset.id,
    storageProvider: provider.key,
    storageKey: newStorageKey,
    checksum: newChecksum,
    filename: params.file.name,
    mimeType: params.file.type,
    sizeBytes: params.file.size,
    width: dimensions.width,
    height: dimensions.height,
    reason: params.reason || "Asset replaced in media operations",
  });

  if (!replaced.ok) {
    // If DB transaction fails, clean up newly uploaded blob to avoid orphaned storage objects
    await provider.remove(newStorageKey).catch(() => undefined);
    return { ok: false, error: replaced.error, status: 500 };
  }

  return { ok: true, data: { asset: replaced.asset, replacement: replaced.replacement } };
}

export async function listAssetReplacements(workspaceId: string, assetId: string): Promise<AssetReplacementRow[]> {
  return listReplacementRows(workspaceId, assetId);
}
