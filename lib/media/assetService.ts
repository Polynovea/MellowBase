import { createHash } from "node:crypto";
import { findActiveAssetByChecksum, insertAsset, listActiveAssets } from "@/lib/media/mediaData";
import { getStorageProvider } from "@/lib/media/storageProvider";
import { checkWorkspaceQuota } from "@/lib/media/uploadLimits";

const ALLOWED_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif", "video/mp4", "video/webm", "application/pdf"]);
const MAX_SIZE = 20 * 1024 * 1024;
export interface AssetRow { id: string; workspace_id: string; storage_provider: string; storage_key: string; filename: string; mime_type: string; size_bytes: number; checksum: string; alt_text: string | null; caption: string | null; folder: string; metadata_json: Record<string, unknown>; created_at: string; archived_at: string | null; }
export type AssetResult<T> = { ok: true; data: T } | { ok: false; error: string; status: number };

function safeSegment(value: string) { return value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "file"; }
export async function listAssets(workspaceId: string): Promise<AssetRow[]> { return listActiveAssets(workspaceId); }
export async function registerUpload(params: { workspaceId: string; actorAdminUserId: string; file: File; folder?: string; altText?: string; caption?: string; environmentId?: string | null }): Promise<AssetResult<AssetRow>> {
  if (!ALLOWED_TYPES.has(params.file.type)) return { ok: false, error: `Unsupported file type: ${params.file.type}`, status: 415 };
  if (params.file.size > MAX_SIZE) return { ok: false, error: "Asset exceeds 20 MB limit", status: 413 };
  const quota = await checkWorkspaceQuota(params.workspaceId, params.file.size); if (!quota.ok) return { ok: false, error: quota.error, status: quota.status };
  const body = Buffer.from(await params.file.arrayBuffer()); const checksum = createHash("sha256").update(body).digest("hex");
  const existing = await findActiveAssetByChecksum(params.workspaceId, checksum);
  if (existing) return { ok: true, data: existing };
  const folder = safeSegment(params.folder || "general"); const filename = safeSegment(params.file.name); const storageKey = `${params.workspaceId}/${folder}/${Date.now()}-${checksum.slice(0, 12)}-${filename}`;
  const provider = await getStorageProvider({ workspaceId: params.workspaceId, environmentId: params.environmentId });
  await provider.upload({ body, key: storageKey, contentType: params.file.type });
  const inserted = await insertAsset(
    { workspace_id: params.workspaceId, storage_provider: provider.key, storage_key: storageKey, filename: params.file.name, mime_type: params.file.type, size_bytes: params.file.size, checksum, alt_text: params.altText || null, caption: params.caption || null, folder, metadata_json: { storageConnectionId: provider.connectionId, storageEnvironmentId: provider.environmentId, storageKind: provider.kind }, created_by: params.actorAdminUserId },
    (asset) => ({ workspaceId: params.workspaceId, actorAdminUserId: params.actorAdminUserId, action: "media.asset.uploaded", entityType: "asset", entityId: asset.id, metadata: { checksum, storageProvider: provider.key, storageConnectionId: provider.connectionId, storageEnvironmentId: provider.environmentId } }),
  );
  if (!inserted.ok) { await provider.remove(storageKey).catch(() => undefined); return { ok: false, error: inserted.error, status: 500 }; }
  return { ok: true, data: inserted.asset };
}
