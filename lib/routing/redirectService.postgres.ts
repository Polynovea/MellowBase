// PostgreSQL implementation of the routing area's redirect service (phase 1, wave 1).
//
// Deliberate differences from the Supabase path it replaced in phase 1:
// - Updating a redirect (history row, update, audit) and deleting one (delete, audit) are each one
// transaction; the old path wrote the history row even when the update then failed.
// - Bulk import writes the rows and the audit row in one transaction, and loads each locale's
// active redirects once for the loop checks instead of once per row.
// - Locale filters are bound parameters. The old path built a PostgREST `or` filter from the
// locale string; it stayed inside the workspace filter, but a crafted locale could change it.
// - Loop detection reads locale-specific rules after the locale-less ones, so a locale-specific
// rule for the same source path is the one followed (the old order was undefined).
// - Malformed IDs in reads are "not found"; explicit list limits; every statement is scoped by
// workspace_id.
import { DEFAULT_LIST_LIMIT, expectOne, getDb, maybeOne, withTransaction, type DbExecutor } from "@/lib/db/index";
import { recordPlatformEvent } from "@/lib/platform/audit.postgres";
import { detectRedirectLoopWith, validateImportItems } from "@/lib/routing/redirectRules";
import { normalizePath } from "@/lib/routing/routePaths";
import type { BulkImportItem, BulkImportReport, RedirectRow } from "@/lib/routing/redirectService";

const LIST_LIMIT = DEFAULT_LIST_LIMIT;
// Loop detection needs the whole rule set; past this many rules a workspace needs a smarter check.
const LOOP_RULE_LIMIT = 50_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (value: string) => UUID.test(value);

const asRedirect = (row: unknown) => row as RedirectRow;

async function loadActiveRedirects(executor: DbExecutor, workspaceId: string, locale?: string | null) {
  let query = executor
    .selectFrom("content_redirects")
    .select(["source_path", "target_path", "locale"])
    .where("workspace_id", "=", workspaceId)
    .where("is_active", "=", true);
  if (locale) query = query.where((eb) => eb.or([eb("locale", "=", locale), eb("locale", "is", null)]));
  return query.orderBy("locale", (ob) => ob.asc().nullsFirst()).orderBy("created_at").limit(LOOP_RULE_LIMIT).execute();
}

/**
 * Loop Detection Algorithm:
 * Follows the redirect chain from targetPath up to maxHops (10).
 * If it circles back to sourcePath or forms a closed loop, returns isLoop = true.
 */
export async function detectRedirectLoop(
  workspaceId: string,
  sourcePath: string,
  targetPath: string,
  locale?: string | null,
): Promise<{ isLoop: boolean; loopPath?: string[]; error?: string }> {
  return detectRedirectLoopWith(() => loadActiveRedirects(getDb(), workspaceId, locale), sourcePath, targetPath);
}

export async function validateRedirectTarget(
  workspaceId: string,
  targetPath: string,
  locale?: string | null,
): Promise<{ isBrokenTarget: boolean; targetType: "internal_route" | "external_url" | "broken" }> {
  if (targetPath.startsWith("http://") || targetPath.startsWith("https://")) {
    return { isBrokenTarget: false, targetType: "external_url" };
  }

  const norm = normalizePath(targetPath);
  if (!norm.ok) return { isBrokenTarget: true, targetType: "broken" };

  let query = getDb()
    .selectFrom("content_routes")
    .select("id")
    .where("workspace_id", "=", workspaceId)
    .where("path", "=", norm.path)
    .where("status", "!=", "archived");
  if (locale) query = query.where("locale", "=", locale);
  const found = await query.limit(1).execute();
  return {
    isBrokenTarget: found.length === 0,
    targetType: found.length ? "internal_route" : "broken",
  };
}

export async function listRedirects(workspaceId: string, locale?: string): Promise<RedirectRow[]> {
  let query = getDb().selectFrom("content_redirects").selectAll().where("workspace_id", "=", workspaceId);
  if (locale) query = query.where((eb) => eb.or([eb("locale", "=", locale), eb("locale", "is", null)]));
  const rows = await query.orderBy("created_at", "desc").limit(LIST_LIMIT).execute();
  return rows.map(asRedirect);
}

async function findRedirect(executor: DbExecutor, workspaceId: string, id: string, lock = false): Promise<RedirectRow | null> {
  if (!isUuid(id)) return null;
  let query = executor.selectFrom("content_redirects").selectAll().where("workspace_id", "=", workspaceId).where("id", "=", id);
  if (lock) query = query.forUpdate();
  const row = maybeOne(await query.execute());
  return row ? asRedirect(row) : null;
}

export async function getRedirect(workspaceId: string, id: string): Promise<RedirectRow | null> {
  return findRedirect(getDb(), workspaceId, id);
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

  return withTransaction(async (trx) => {
    const loopCheck = await detectRedirectLoopWith(() => loadActiveRedirects(trx, params.workspaceId, params.locale), normSource.path, params.targetPath);
    if (loopCheck.isLoop) {
      throw new Error(loopCheck.error || "Cannot create redirect: creates a loop");
    }

    const data = asRedirect(expectOne(await trx
      .insertInto("content_redirects")
      .values({
        workspace_id: params.workspaceId,
        locale: params.locale || null,
        source_path: normSource.path,
        target_path: params.targetPath.trim(),
        status_code: params.statusCode || 301,
        is_active: params.isActive ?? true,
        description: params.description?.trim() || null,
        created_by: params.actorAdminUserId,
      })
      .returningAll()
      .execute(), "Could not create redirect"));

    await recordPlatformEvent(trx, {
      workspaceId: params.workspaceId,
      actorAdminUserId: params.actorAdminUserId,
      action: "redirect.created",
      entityType: "redirect",
      entityId: data.id,
      metadata: { sourcePath: data.source_path, targetPath: data.target_path, statusCode: data.status_code },
    });

    return data;
  });
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
  return withTransaction(async (trx) => {
    const current = await findRedirect(trx, params.workspaceId, params.id, true);
    if (!current) throw new Error("Redirect not found in workspace");

    const sourcePath = params.sourcePath ? normalizePath(params.sourcePath) : { ok: true as const, path: current.source_path };
    if (!sourcePath.ok) throw new Error(sourcePath.error);
    const targetPath = params.targetPath ? params.targetPath.trim() : current.target_path;

    if (params.sourcePath || params.targetPath) {
      const loopCheck = await detectRedirectLoopWith(() => loadActiveRedirects(trx, params.workspaceId, current.locale), sourcePath.path, targetPath);
      if (loopCheck.isLoop) {
        throw new Error(loopCheck.error || "Cannot update redirect: creates a loop");
      }
    }

    await trx.insertInto("content_redirect_history").values({
      workspace_id: params.workspaceId,
      redirect_id: current.id,
      old_source_path: current.source_path,
      new_source_path: sourcePath.path,
      old_target_path: current.target_path,
      new_target_path: targetPath,
      old_status_code: current.status_code,
      new_status_code: params.statusCode || current.status_code,
      changed_by: params.actorAdminUserId,
    }).execute();

    const updates: { source_path: string; target_path: string; updated_at: string; status_code?: number; is_active?: boolean; description?: string | null } = {
      source_path: sourcePath.path,
      target_path: targetPath,
      updated_at: new Date().toISOString(),
    };
    if (params.statusCode !== undefined) updates.status_code = params.statusCode;
    if (params.isActive !== undefined) updates.is_active = params.isActive;
    if (params.description !== undefined) updates.description = params.description?.trim() || null;

    const data = asRedirect(expectOne(await trx
      .updateTable("content_redirects")
      .set(updates)
      .where("workspace_id", "=", params.workspaceId)
      .where("id", "=", current.id)
      .returningAll()
      .execute(), "Could not update redirect"));

    await recordPlatformEvent(trx, {
      workspaceId: params.workspaceId,
      actorAdminUserId: params.actorAdminUserId,
      action: "redirect.updated",
      entityType: "redirect",
      entityId: data.id,
      metadata: updates,
    });

    return data;
  });
}

export async function deleteRedirect(params: {
  workspaceId: string;
  actorAdminUserId: string;
  id: string;
}): Promise<{ ok: true }> {
  if (!isUuid(params.id)) throw new Error("Invalid redirect ID");
  await withTransaction(async (trx) => {
    await trx
      .deleteFrom("content_redirects")
      .where("workspace_id", "=", params.workspaceId)
      .where("id", "=", params.id)
      .execute();
    await recordPlatformEvent(trx, {
      workspaceId: params.workspaceId,
      actorAdminUserId: params.actorAdminUserId,
      action: "redirect.deleted",
      entityType: "redirect",
      entityId: params.id,
      metadata: {},
    });
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

  const rulesByLocale = new Map<string, ReturnType<typeof loadActiveRedirects>>();
  const validItems = await validateImportItems(params.items, report, (sourcePath, targetPath, locale) => {
    const key = locale || "";
    if (!rulesByLocale.has(key)) rulesByLocale.set(key, loadActiveRedirects(getDb(), params.workspaceId, locale));
    return detectRedirectLoopWith(() => rulesByLocale.get(key)!, sourcePath, targetPath);
  });

  if (!report.dryRun && validItems.length > 0) {
    await withTransaction(async (trx) => {
      const rows = await trx
        .insertInto("content_redirects")
        .values(validItems.map((v) => ({
          workspace_id: params.workspaceId,
          locale: v.locale,
          source_path: v.sourcePath,
          target_path: v.targetPath,
          status_code: v.statusCode,
          is_active: true,
          description: v.description,
          created_by: params.actorAdminUserId,
        })))
        // Same as the Supabase upsert on (workspace_id, locale, source_path): every column it sent.
        .onConflict((conflict) => conflict.columns(["workspace_id", "locale", "source_path"]).doUpdateSet((eb) => ({
          target_path: eb.ref("excluded.target_path"),
          status_code: eb.ref("excluded.status_code"),
          is_active: eb.ref("excluded.is_active"),
          description: eb.ref("excluded.description"),
          created_by: eb.ref("excluded.created_by"),
        })))
        .returningAll()
        .execute();
      report.imported = rows.map(asRedirect);

      await recordPlatformEvent(trx, {
        workspaceId: params.workspaceId,
        actorAdminUserId: params.actorAdminUserId,
        action: "redirect.bulk_imported",
        entityType: "redirect",
        entityId: params.workspaceId,
        metadata: { total: validItems.length },
      });
    });
  }

  return report;
}
