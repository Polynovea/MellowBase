// Direct PostgreSQL implementation of the navigation area (phase 1, wave 1).
//
// Same signatures and return shapes as navigationService.supabase.ts; the dispatcher in
// navigationService.ts picks one per POLYNOVEA_DATA_BACKEND. Differences that are deliberate:
// - Creating a menu, saving a draft and publishing each run in one transaction, together with the
//   dependency-graph edges and the audit row. The Supabase path ignored errors from its follow-up
//   writes, so a failure could leave a menu pointing at no draft, or edges out of date.
// - Saving a draft locks the menu row, so two concurrent saves get consecutive version numbers
//   instead of one failing on the unique version number.
// - saveMenuDraft accepts a menu key as well as an ID (the Supabase path looked the menu up by key
//   but then wrote the key into menu_id, which failed).
// - Tree resolution loads only the routes the tree links to, not every route in the workspace
//   (PostgREST capped that at 1000 rows, so large workspaces could resolve links to /entry/<id>).
//   Several routes for one entry resolve deterministically: a route in the requested locale wins,
//   and among equals the canonical route.
// - "Where used" searches the version JSON in SQL instead of loading every version into memory.
// - Every list query has an explicit limit, and every statement is scoped by workspace_id.
import { sql } from "kysely";
import { callFunction, DEFAULT_LIST_LIMIT, expectOne, getDb, maybeOne, withTransaction, type DbExecutor } from "@/lib/db/index";
import { recordPlatformEvent } from "@/lib/platform/audit.postgres";
import { collectMenuRelations, findMenusUsingEntry, referencedTargets, resolveNavigationItems } from "@/lib/navigation/navigationTree";
import type { NavigationItemData, NavigationMenuRow, NavigationVersionRow, ResolvedNavigationNode } from "@/lib/navigation/navigationService";

const LIST_LIMIT = DEFAULT_LIST_LIMIT;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (value: string) => UUID.test(value);

const asVersion = (row: unknown) => row as NavigationVersionRow;

function menuQuery(executor: DbExecutor, workspaceId: string, idOrKey: string) {
  const query = executor.selectFrom("navigation_menus").selectAll().where("workspace_id", "=", workspaceId);
  return isUuid(idOrKey) ? query.where("id", "=", idOrKey) : query.where("key", "=", idOrKey);
}

export async function listMenus(workspaceId: string): Promise<NavigationMenuRow[]> {
  return getDb()
    .selectFrom("navigation_menus")
    .selectAll()
    .where("workspace_id", "=", workspaceId)
    .orderBy("name", "asc")
    .limit(LIST_LIMIT)
    .execute();
}

export async function getMenu(workspaceId: string, idOrKey: string): Promise<NavigationMenuRow | null> {
  return maybeOne(await menuQuery(getDb(), workspaceId, idOrKey).execute());
}

async function replaceMenuRelations(executor: DbExecutor, workspaceId: string, menuId: string, items: NavigationItemData[]) {
  await callFunction("cms_replace_source_relations", {
    p_workspace_id: workspaceId,
    p_source_type: "menu",
    p_source_id: menuId,
    // jsonb argument: serialized here, since the driver would send a JS array as a PostgreSQL array.
    p_relations: JSON.stringify(collectMenuRelations(workspaceId, menuId, items)),
  }, executor);
}

export async function createMenu(params: {
  workspaceId: string;
  actorAdminUserId: string;
  key: string;
  name: string;
  description?: string | null;
  initialItems?: NavigationItemData[];
}): Promise<{ menu: NavigationMenuRow; version: NavigationVersionRow }> {
  const key = params.key.toLowerCase().trim().replace(/[^a-z0-9_-]+/g, "_");

  return withTransaction(async (trx) => {
    const menu = expectOne(await trx
      .insertInto("navigation_menus")
      .values({
        workspace_id: params.workspaceId,
        key,
        name: params.name.trim(),
        description: params.description?.trim() || null,
      })
      .returningAll()
      .execute(), "Could not create menu");

    const version = expectOne(await trx
      .insertInto("navigation_menu_versions")
      .values({
        workspace_id: params.workspaceId,
        menu_id: menu.id,
        version_number: 1,
        state: "draft",
        items_jsonb: JSON.stringify(params.initialItems || []),
        change_summary: "Initial menu structure",
        created_by: params.actorAdminUserId,
      })
      .returningAll()
      .execute(), "Could not create initial menu version");

    await trx
      .updateTable("navigation_menus")
      .set({ current_draft_version_id: version.id })
      .where("workspace_id", "=", params.workspaceId)
      .where("id", "=", menu.id)
      .execute();

    if (params.initialItems && params.initialItems.length) {
      await replaceMenuRelations(trx, params.workspaceId, menu.id, params.initialItems);
    }

    await recordPlatformEvent(trx, {
      workspaceId: params.workspaceId,
      actorAdminUserId: params.actorAdminUserId,
      action: "navigation.menu.created",
      entityType: "navigation_menu",
      entityId: menu.id,
      metadata: { key: menu.key, name: menu.name },
    });

    return {
      menu: { ...menu, current_draft_version_id: version.id },
      version: asVersion(version),
    };
  });
}

/**
 * Synchronize generic dependency graph edges for a navigation menu.
 */
export async function syncMenuRelations(workspaceId: string, menuId: string, items: NavigationItemData[]): Promise<void> {
  await replaceMenuRelations(getDb(), workspaceId, menuId, items);
}

export async function saveMenuDraft(params: {
  workspaceId: string;
  actorAdminUserId: string;
  menuId: string;
  items: NavigationItemData[];
  changeSummary?: string;
}): Promise<NavigationVersionRow> {
  return withTransaction(async (trx) => {
    const menu = maybeOne(await menuQuery(trx, params.workspaceId, params.menuId).forUpdate().execute());
    if (!menu) throw new Error("Menu not found");

    const latest = await trx
      .selectFrom("navigation_menu_versions")
      .select(sql<number>`coalesce(max(version_number), 0)`.as("version_number"))
      .where("workspace_id", "=", params.workspaceId)
      .where("menu_id", "=", menu.id)
      .executeTakeFirstOrThrow();
    const nextVersionNumber = latest.version_number + 1;

    const newVersion = expectOne(await trx
      .insertInto("navigation_menu_versions")
      .values({
        workspace_id: params.workspaceId,
        menu_id: menu.id,
        version_number: nextVersionNumber,
        state: "draft",
        items_jsonb: JSON.stringify(params.items),
        change_summary: params.changeSummary || `Draft update v${nextVersionNumber}`,
        created_by: params.actorAdminUserId,
      })
      .returningAll()
      .execute(), "Could not save menu draft");

    await trx
      .updateTable("navigation_menus")
      .set({ current_draft_version_id: newVersion.id, updated_at: new Date().toISOString() })
      .where("workspace_id", "=", params.workspaceId)
      .where("id", "=", menu.id)
      .execute();

    await replaceMenuRelations(trx, params.workspaceId, menu.id, params.items);

    await recordPlatformEvent(trx, {
      workspaceId: params.workspaceId,
      actorAdminUserId: params.actorAdminUserId,
      action: "navigation.menu.draft_saved",
      entityType: "navigation_menu",
      entityId: menu.id,
      metadata: { versionNumber: nextVersionNumber },
    });

    return asVersion(newVersion);
  });
}

export async function publishMenu(params: {
  workspaceId: string;
  actorAdminUserId: string;
  menuId: string;
  versionNumber?: number;
}): Promise<NavigationVersionRow> {
  return withTransaction(async (trx) => {
    const data = await callFunction("cms_publish_navigation_menu", {
      p_workspace_id: params.workspaceId,
      p_actor_id: params.actorAdminUserId,
      p_menu_id: params.menuId,
      p_version_number: params.versionNumber ?? null,
    }, trx);
    if (!data) throw new Error("Could not publish navigation menu");

    const published = asVersion(data);
    if (published.items_jsonb) {
      await replaceMenuRelations(trx, params.workspaceId, params.menuId, published.items_jsonb);
    }
    return published;
  });
}

export async function listMenuVersions(workspaceId: string, menuId: string): Promise<NavigationVersionRow[]> {
  if (!isUuid(menuId)) return [];
  const rows = await getDb()
    .selectFrom("navigation_menu_versions")
    .selectAll()
    .where("workspace_id", "=", workspaceId)
    .where("menu_id", "=", menuId)
    .orderBy("version_number", "desc")
    .limit(LIST_LIMIT)
    .execute();
  return rows.map(asVersion);
}

/**
 * Resolves Navigation Tree for Website or Preview delivery:
 * 1. Loads draft or published version items.
 * 2. Resolves localized labels for the specified locale.
 * 3. Resolves internal canonical routes or entry URLs.
 * 4. Filters out items not matching the audience rule.
 */
export async function getResolvedNavigationTree(params: {
  workspaceId: string;
  menuKey: string;
  locale?: string;
  mode?: "preview" | "published";
  audience?: "all" | "authenticated" | "guest";
}): Promise<ResolvedNavigationNode[]> {
  const db = getDb();
  const menu = await getMenu(params.workspaceId, params.menuKey);
  if (!menu) return [];

  const versionId = params.mode === "preview" ? menu.current_draft_version_id || menu.published_version_id : menu.published_version_id;
  if (!versionId) return [];

  const version = maybeOne(await db
    .selectFrom("navigation_menu_versions")
    .select("items_jsonb")
    .where("workspace_id", "=", params.workspaceId)
    .where("id", "=", versionId)
    .execute());
  if (!version || !Array.isArray(version.items_jsonb)) return [];

  const items = version.items_jsonb as unknown as NavigationItemData[];
  const locale = params.locale || "en";
  const audience = params.audience || "all";

  const { entryIds, routeIds } = referencedTargets(items);
  const validEntryIds = entryIds.filter(isUuid);
  const validRouteIds = routeIds.filter(isUuid);
  const routes = validEntryIds.length || validRouteIds.length
    ? await db
      .selectFrom("content_routes")
      .select(["id", "entry_id", "path", "locale", "is_canonical"])
      .where("workspace_id", "=", params.workspaceId)
      .where("status", "!=", "archived")
      .where((eb) => eb.or([
        ...(validEntryIds.length ? [eb("entry_id", "in", validEntryIds)] : []),
        ...(validRouteIds.length ? [eb("id", "in", validRouteIds)] : []),
      ]))
      // resolveNavigationItems keeps the first route for an entry unless a later one is in the
      // locale, so: other-locale routes first, canonical first among them; then in-locale routes,
      // canonical last so it is the one kept.
      .orderBy(sql`locale = ${locale}`)
      .orderBy(sql`case when locale = ${locale} then is_canonical::int else -is_canonical::int end`)
      .orderBy("id")
      .execute()
    : [];

  return resolveNavigationItems(items, routes, locale, audience);
}

export async function getNavigationWhereUsed(workspaceId: string, entryId: string): Promise<{ menuId: string; menuKey: string; menuName: string }[]> {
  const rows = await getDb()
    .selectFrom("navigation_menu_versions as v")
    .innerJoin("navigation_menus as m", (join) => join.onRef("m.id", "=", "v.menu_id").onRef("m.workspace_id", "=", "v.workspace_id"))
    .select(["m.id", "m.key", "m.name", "v.items_jsonb"])
    .where("v.workspace_id", "=", workspaceId)
    .where(sql<boolean>`jsonb_path_exists(v.items_jsonb, '$.** ? (@.targetEntryId == $id)', jsonb_build_object('id', ${entryId}::text), true)`)
    .orderBy("m.name")
    .orderBy("v.version_number", "desc")
    .limit(LIST_LIMIT)
    .execute();
  // The SQL filter narrows the versions; the shared scan keeps the Supabase path's exact matching rules.
  return findMenusUsingEntry(
    rows.map((row) => ({ menu: { id: row.id, key: row.key, name: row.name }, items: Array.isArray(row.items_jsonb) ? row.items_jsonb as unknown as NavigationItemData[] : [] })),
    entryId,
  );
}

export async function updateMenuDetails(params: {
  workspaceId: string;
  menu: NavigationMenuRow;
  name?: string;
  description?: string | null;
}): Promise<void> {
  await getDb()
    .updateTable("navigation_menus")
    .set({
      name: params.name ? params.name.trim() : params.menu.name,
      description: params.description !== undefined ? params.description?.trim() || null : params.menu.description,
      updated_at: new Date().toISOString(),
    })
    .where("workspace_id", "=", params.workspaceId)
    .where("id", "=", params.menu.id)
    .execute();
}

/** Deletes the menu and records the audit event in the same transaction. */
export async function deleteMenu(params: { workspaceId: string; actorAdminUserId: string; menuId: string }): Promise<void> {
  if (!isUuid(params.menuId)) throw new Error("Invalid navigation menu ID");
  await withTransaction(async (trx) => {
    await trx
      .deleteFrom("navigation_menus")
      .where("workspace_id", "=", params.workspaceId)
      .where("id", "=", params.menuId)
      .execute();
    await recordPlatformEvent(trx, {
      workspaceId: params.workspaceId,
      actorAdminUserId: params.actorAdminUserId,
      action: "navigation.menu.deleted",
      entityType: "navigation_menu",
      entityId: params.menuId,
      metadata: {},
    });
  });
}
