// Supabase path of the routing area's redirect service (deleted with the switch at the end of phase 1).
import { createServiceRoleClient } from "@/lib/admin/serviceRole";
import { logPlatformEvent } from "@/lib/platform/audit";
import { normalizePath } from "@/lib/routing/routeService";
import { detectRedirectLoopWith, validateImportItems } from "@/lib/routing/redirectRules";
import type { BulkImportItem, BulkImportReport, RedirectRow } from "@/lib/routing/redirectService";

/**
 * Loop Detection Algorithm: see detectRedirectLoopWith in redirectRules.ts.
 */
export async function detectRedirectLoop(
  workspaceId: string,
  sourcePath: string,
  targetPath: string,
  locale?: string | null
): Promise<{ isLoop: boolean; loopPath?: string[]; error?: string }> {
  return detectRedirectLoopWith(async () => {
    const db = createServiceRoleClient();
    let query = db
      .from("content_redirects")
      .select("source_path, target_path, locale")
      .eq("workspace_id", workspaceId)
      .eq("is_active", true);

    if (locale) {
      query = query.or(`locale.eq.${locale},locale.is.null`);
    }

    const { data } = await query;
    return data ?? [];
  }, sourcePath, targetPath);
}

export async function validateRedirectTarget(
  workspaceId: string,
  targetPath: string,
  locale?: string | null
): Promise<{ isBrokenTarget: boolean; targetType: "internal_route" | "external_url" | "broken" }> {
  if (targetPath.startsWith("http://") || targetPath.startsWith("https://")) {
    return { isBrokenTarget: false, targetType: "external_url" };
  }

  const norm = normalizePath(targetPath);
  if (!norm.ok) return { isBrokenTarget: true, targetType: "broken" };

  const db = createServiceRoleClient();
  let query = db
    .from("content_routes")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("path", norm.path)
    .neq("status", "archived");

  if (locale) {
    query = query.eq("locale", locale);
  }

  const { data } = await query.maybeSingle();
  return {
    isBrokenTarget: !data,
    targetType: data ? "internal_route" : "broken",
  };
}

export async function listRedirects(workspaceId: string, locale?: string): Promise<RedirectRow[]> {
  const db = createServiceRoleClient();
  let query = db
    .from("content_redirects")
    .select("*")
    .eq("workspace_id", workspaceId)
    .order("created_at", { ascending: false });

  if (locale) {
    query = query.or(`locale.eq.${locale},locale.is.null`);
  }

  const { data } = await query;
  return (data as RedirectRow[]) ?? [];
}

export async function getRedirect(workspaceId: string, id: string): Promise<RedirectRow | null> {
  const { data } = await createServiceRoleClient()
    .from("content_redirects")
    .select("*")
    .eq("workspace_id", workspaceId)
    .eq("id", id)
    .maybeSingle();
  return (data as RedirectRow) ?? null;
}

export async function createRedirect(params: {
  workspaceId: string;
  actorAdminUserId: string;
  sourcePath: string;
  targetPath: string;
  statusCode?: 301 | 302 | 307 | 308;
  locale?: string | null;
  description?: string | null;
  isActive?: boolean;
}): Promise<RedirectRow> {
  const normSource = normalizePath(params.sourcePath);
  if (!normSource.ok) throw new Error(normSource.error);

  const loopCheck = await detectRedirectLoop(
    params.workspaceId,
    normSource.path,
    params.targetPath,
    params.locale
  );
  if (loopCheck.isLoop) {
    throw new Error(loopCheck.error || "Cannot create redirect: creates a loop");
  }

  const db = createServiceRoleClient();
  const statusCode = params.statusCode || 301;

  const { data, error } = await db
    .from("content_redirects")
    .insert({
      workspace_id: params.workspaceId,
      locale: params.locale || null,
      source_path: normSource.path,
      target_path: params.targetPath.trim(),
      status_code: statusCode,
      is_active: params.isActive ?? true,
      description: params.description?.trim() || null,
      created_by: params.actorAdminUserId,
    })
    .select()
    .single();

  if (error || !data) throw new Error(error?.message || "Could not create redirect");

  await logPlatformEvent({
    workspaceId: params.workspaceId,
    actorAdminUserId: params.actorAdminUserId,
    action: "redirect.created",
    entityType: "redirect",
    entityId: data.id,
    metadata: {
      sourcePath: data.source_path,
      targetPath: data.target_path,
      statusCode: data.status_code,
    },
  });

  return data as RedirectRow;
}

export async function updateRedirect(params: {
  workspaceId: string;
  actorAdminUserId: string;
  id: string;
  sourcePath?: string;
  targetPath?: string;
  statusCode?: 301 | 302 | 307 | 308;
  isActive?: boolean;
  description?: string | null;
}): Promise<RedirectRow> {
  const db = createServiceRoleClient();
  const current = await getRedirect(params.workspaceId, params.id);
  if (!current) throw new Error("Redirect not found in workspace");

  const sourcePath = params.sourcePath ? normalizePath(params.sourcePath) : { ok: true as const, path: current.source_path };
  if (!sourcePath.ok) throw new Error(sourcePath.error);

  const targetPath = params.targetPath ? params.targetPath.trim() : current.target_path;

  if (params.sourcePath || params.targetPath) {
    const loopCheck = await detectRedirectLoop(
      params.workspaceId,
      sourcePath.path,
      targetPath,
      current.locale
    );
    if (loopCheck.isLoop) {
      throw new Error(loopCheck.error || "Cannot update redirect: creates a loop");
    }
  }

  // 1. Record history
  await db.from("content_redirect_history").insert({
    workspace_id: params.workspaceId,
    redirect_id: current.id,
    old_source_path: current.source_path,
    new_source_path: sourcePath.path,
    old_target_path: current.target_path,
    new_target_path: targetPath,
    old_status_code: current.status_code,
    new_status_code: params.statusCode || current.status_code,
    changed_by: params.actorAdminUserId,
  });

  const updates: Record<string, unknown> = {
    source_path: sourcePath.path,
    target_path: targetPath,
    updated_at: new Date().toISOString(),
  };
  if (params.statusCode !== undefined) updates.status_code = params.statusCode;
  if (params.isActive !== undefined) updates.is_active = params.isActive;
  if (params.description !== undefined) updates.description = params.description?.trim() || null;

  const { data, error } = await db
    .from("content_redirects")
    .update(updates)
    .eq("workspace_id", params.workspaceId)
    .eq("id", params.id)
    .select()
    .single();

  if (error || !data) throw new Error(error?.message || "Could not update redirect");

  await logPlatformEvent({
    workspaceId: params.workspaceId,
    actorAdminUserId: params.actorAdminUserId,
    action: "redirect.updated",
    entityType: "redirect",
    entityId: data.id,
    metadata: updates,
  });

  return data as RedirectRow;
}

export async function deleteRedirect(params: {
  workspaceId: string;
  actorAdminUserId: string;
  id: string;
}): Promise<{ ok: true }> {
  const db = createServiceRoleClient();
  const { error } = await db
    .from("content_redirects")
    .delete()
    .eq("workspace_id", params.workspaceId)
    .eq("id", params.id);

  if (error) throw new Error(error.message);

  await logPlatformEvent({
    workspaceId: params.workspaceId,
    actorAdminUserId: params.actorAdminUserId,
    action: "redirect.deleted",
    entityType: "redirect",
    entityId: params.id,
    metadata: {},
  });

  return { ok: true };
}

/**
 * Bulk Import with Dry-Run validation:
 * Validates syntax, normalizes paths, detects duplicate source paths in import,
 * and checks circular loops against existing redirects.
 */
export async function importRedirects(params: {
  workspaceId: string;
  actorAdminUserId: string;
  items: BulkImportItem[];
  dryRun?: boolean;
}): Promise<BulkImportReport> {
  const report: BulkImportReport = {
    dryRun: params.dryRun ?? true,
    totalRows: params.items.length,
    validCount: 0,
    errorCount: 0,
    errors: [],
    imported: [],
  };

  const validItems = await validateImportItems(params.items, report, (sourcePath, targetPath, locale) =>
    detectRedirectLoop(params.workspaceId, sourcePath, targetPath, locale));

  if (!report.dryRun && validItems.length > 0) {
    const db = createServiceRoleClient();
    const rows = validItems.map((v) => ({
      workspace_id: params.workspaceId,
      locale: v.locale,
      source_path: v.sourcePath,
      target_path: v.targetPath,
      status_code: v.statusCode,
      is_active: true,
      description: v.description,
      created_by: params.actorAdminUserId,
    }));

    const { data, error } = await db
      .from("content_redirects")
      .upsert(rows, { onConflict: "workspace_id,locale,source_path" })
      .select();

    if (error) throw new Error(error.message);
    report.imported = (data as RedirectRow[]) ?? [];

    await logPlatformEvent({
      workspaceId: params.workspaceId,
      actorAdminUserId: params.actorAdminUserId,
      action: "redirect.bulk_imported",
      entityType: "redirect",
      entityId: params.workspaceId,
      metadata: { total: validItems.length },
    });
  }

  return report;
}
