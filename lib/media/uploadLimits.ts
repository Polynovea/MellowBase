import { createServiceRoleClient } from "@/lib/admin/serviceRole";

// Upload size and storage-quota policy shared by every upload path (direct, presigned and asset registry).

const MB = 1024 * 1024;

/** Largest single object accepted, by MIME family. */
export function maxUploadBytes(contentType: string): number {
  return contentType.startsWith("video/") ? 200 * MB : 10 * MB;
}

/**
 * Validates the size a client declares for a presigned upload. The size is then signed into the URL as
 * Content-Length, so the storage provider refuses any body of a different length.
 */
export function parseDeclaredSize(value: unknown, contentType: string): { ok: true; bytes: number } | { ok: false; status: 400 | 413; error: string } {
  const bytes = typeof value === "number" ? value : typeof value === "string" && /^\d+$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(bytes) || bytes <= 0) return { ok: false, status: 400, error: "size (bytes) is required and must be a positive integer" };
  const max = maxUploadBytes(contentType);
  if (bytes > max) return { ok: false, status: 413, error: `File exceeds the ${Math.round(max / MB)} MB limit for ${contentType}` };
  return { ok: true, bytes };
}

/**
 * Per-workspace storage quota in bytes from MEDIA_WORKSPACE_QUOTA_BYTES, or null when the operator has not
 * set one. Usage is the size of the workspace's live registered assets.
 */
export function workspaceQuotaBytes(env: Record<string, string | undefined> = process.env): number | null {
  const raw = env.MEDIA_WORKSPACE_QUOTA_BYTES?.trim();
  if (!raw) return null;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error("MEDIA_WORKSPACE_QUOTA_BYTES must be a positive integer number of bytes");
  return value;
}

export async function checkWorkspaceQuota(workspaceId: string, incomingBytes: number): Promise<{ ok: true } | { ok: false; status: 413; error: string }> {
  const quota = workspaceQuotaBytes();
  if (quota === null) return { ok: true };
  const { data, error } = await createServiceRoleClient().from("assets").select("size_bytes").eq("workspace_id", workspaceId).is("archived_at", null);
  if (error) throw error;
  const used = (data ?? []).reduce((sum: number, row: { size_bytes: number | string }) => sum + Number(row.size_bytes || 0), 0);
  if (used + incomingBytes > quota) {
    return { ok: false, status: 413, error: `Workspace storage quota exceeded (${Math.round(used / MB)} MB of ${Math.round(quota / MB)} MB used)` };
  }
  return { ok: true };
}
