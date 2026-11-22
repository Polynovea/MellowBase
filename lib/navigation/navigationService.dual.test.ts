import { afterAll, describe, expect, it, vi } from "vitest";
import { describeBothBackends, type BackendFixtures } from "@/lib/db/testing/dualBackend";
import type { DataBackend } from "@/lib/db/backend";
import {
  createMenu,
  getMenu,
  getNavigationWhereUsed,
  getResolvedNavigationTree,
  listMenus,
  listMenuVersions,
  publishMenu,
  saveMenuDraft,
  type NavigationItemData,
} from "@/lib/navigation/navigationService";
import { GET as listMenusRoute, POST as createMenuRoute } from "@/app/api/navigation/menus/route";
import { DELETE as deleteMenuRoute, GET as getMenuRoute, PUT as updateMenuRoute } from "@/app/api/navigation/menus/[id]/route";
import { POST as publishRoute } from "@/app/api/navigation/menus/[id]/publish/route";
import { GET as treeRoute } from "@/app/api/navigation/menus/[id]/tree/route";

// Route auth is the admin and platform areas' job; here it resolves to the test workspace so the
// navigation routes can be exercised end to end on each backend.
const actor = vi.hoisted(() => ({ workspaceId: "", adminUserId: "" }));
vi.mock("@/lib/platform/permissions", () => ({
  requirePlatformAccess: vi.fn(async () => ({ data: { actor: { ...actor }, adminUser: { id: actor.adminUserId } } })),
}));

const MENU_KEYS = ["created_at", "current_draft_version_id", "description", "id", "key", "name", "published_version_id", "updated_at", "workspace_id"];
const VERSION_KEYS = ["change_summary", "created_at", "created_by", "id", "items_jsonb", "menu_id", "state", "version_number", "workspace_id"];
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?\+00:00$/;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

const sortKeys = (value: unknown): unknown =>
  Array.isArray(value) ? value.map(sortKeys)
  : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, sortKeys(v)]))
  : value;

function normalize(value: unknown): unknown {
  const ids = new Map<string, string>();
  return JSON.parse(JSON.stringify(sortKeys(value)), (_key, v) => {
    if (typeof v !== "string") return v;
    if (ISO.test(v)) return "<timestamp>";
    return v.replace(UUID, (id) => {
      if (!ids.has(id)) ids.set(id, `<id${ids.size + 1}>`);
      return ids.get(id)!;
    });
  });
}

const recorded: Partial<Record<DataBackend, Record<string, unknown>>> = {};
const record = (backend: DataBackend, name: string, value: unknown) => {
  recorded[backend] ??= {};
  recorded[backend]![name] = normalize(value);
};

const req = (body?: unknown, url = "http://cms.test/api/navigation") =>
  new Request(url, body === undefined ? {} : { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
const params = <T extends Record<string, string>>(value: T) => ({ params: Promise.resolve(value) });
const json = async (response: Response) => ({ status: response.status, body: await response.json() });

async function seedTargets(backend: BackendFixtures, workspaceId: string) {
  const { entryId } = await backend.createEntry(workspaceId);
  const { entryId: otherEntryId } = await backend.createEntry(workspaceId);
  const [route] = await backend.query<{ id: string }>(
    "insert into content_routes (workspace_id, entry_id, path, locale) values ($1, $2, '/about', 'en') returning id",
    [workspaceId, entryId],
  );
  await backend.query("insert into content_routes (workspace_id, entry_id, path, locale) values ($1, $2, '/a-propos', 'fr')", [workspaceId, entryId]);
  const [plainRoute] = await backend.query<{ id: string }>(
    "insert into content_routes (workspace_id, path, locale) values ($1, '/contact', 'en') returning id",
    [workspaceId],
  );
  return { entryId, otherEntryId, routeId: route.id, plainRouteId: plainRoute.id };
}

function treeItems(t: { entryId: string; otherEntryId: string; plainRouteId: string }): NavigationItemData[] {
  return [
    {
      id: "home", label: "Home", itemType: "external_url", url: "https://example.test/", openInNewTab: true,
      localizations: [{ locale: "fr", label: "Accueil" }],
      children: [
        { id: "about", label: "About", itemType: "internal_entry", targetEntryId: t.entryId },
        { id: "members", label: "Members", itemType: "external_url", url: "/members", audienceRule: "authenticated" },
        { id: "hidden", label: "Hidden", itemType: "external_url", url: "/hidden", isVisible: false },
      ],
    },
    { id: "contact", label: "Contact", itemType: "internal_route", targetRouteId: t.plainRouteId },
    { id: "orphan", label: "Orphan", itemType: "internal_entry", targetEntryId: t.otherEntryId },
  ];
}

describeBothBackends("navigation", "navigation service", (backend) => {
  it("creates, drafts, publishes and lists menus with identical shapes", async () => {
    const { workspaceId, adminUserId } = await backend.createWorkspace();
    const targets = await seedTargets(backend, workspaceId);
    const items = treeItems(targets);

    const { menu, version } = await createMenu({ workspaceId, actorAdminUserId: adminUserId, key: " Main Menu! ", name: " Main ", description: " Top ", initialItems: items });
    expect(Object.keys(menu).sort()).toEqual(MENU_KEYS);
    expect(Object.keys(version).sort()).toEqual(VERSION_KEYS);
    expect(menu).toMatchObject({ key: "main_menu_", name: "Main", description: "Top", current_draft_version_id: version.id, published_version_id: null });
    expect(version).toMatchObject({ version_number: 1, state: "draft", items_jsonb: items, change_summary: "Initial menu structure", created_by: adminUserId });
    expect(version.created_at).toMatch(ISO);

    await createMenu({ workspaceId, actorAdminUserId: adminUserId, key: "footer", name: "Footer" });
    expect((await listMenus(workspaceId)).map((m) => m.name)).toEqual(["Footer", "Main"]);
    expect(await getMenu(workspaceId, menu.id)).toMatchObject({ id: menu.id, current_draft_version_id: version.id });
    expect((await getMenu(workspaceId, "main_menu_"))?.id).toBe(menu.id);
    expect(await getMenu(workspaceId, "no-such-menu")).toBeNull();

    const draft = await saveMenuDraft({ workspaceId, actorAdminUserId: adminUserId, menuId: menu.id, items: items.slice(0, 2) });
    expect(draft).toMatchObject({ version_number: 2, change_summary: "Draft update v2", state: "draft" });
    const published = await publishMenu({ workspaceId, actorAdminUserId: adminUserId, menuId: menu.id });
    expect(Object.keys(published).sort()).toEqual(VERSION_KEYS);
    expect(published).toMatchObject({ id: draft.id, version_number: 2, state: "published", items_jsonb: items.slice(0, 2) });

    const versions = await listMenuVersions(workspaceId, menu.id);
    expect(versions.map((v) => [v.version_number, v.state])).toEqual([[2, "published"], [1, "draft"]]);
    expect(await listMenuVersions(workspaceId, "not-a-uuid")).toEqual([]);
    expect((await getMenu(workspaceId, menu.id))?.published_version_id).toBe(draft.id);

    record(backend.name, "menu lifecycle", { menu, version, draft, published, versions });
  });

  it("keeps dependency edges in step with the menu's items", async () => {
    const { workspaceId, adminUserId } = await backend.createWorkspace();
    const targets = await seedTargets(backend, workspaceId);
    const { menu } = await createMenu({ workspaceId, actorAdminUserId: adminUserId, key: "edges", name: "Edges", initialItems: treeItems(targets) });
    const edges = async () => (await backend.query<{ relation_type: string; target: string }>(
      `select relation_type, coalesce(target_entry_id, target_route_id)::text as target from content_relations
       where workspace_id = $1 and source_menu_id = $2 order by relation_type, target`,
      [workspaceId, menu.id],
    )).map((row) => `${row.relation_type}:${row.target}`);
    expect(await edges()).toEqual([
      `menu_entry:${[targets.entryId, targets.otherEntryId].sort()[0]}`,
      `menu_entry:${[targets.entryId, targets.otherEntryId].sort()[1]}`,
      `menu_route:${targets.plainRouteId}`,
    ]);
    await saveMenuDraft({ workspaceId, actorAdminUserId: adminUserId, menuId: menu.id, items: [] });
    expect(await edges()).toEqual([]);
  });

  it("resolves the published and preview trees by locale and audience", async () => {
    const { workspaceId, adminUserId } = await backend.createWorkspace();
    const targets = await seedTargets(backend, workspaceId);
    const { menu } = await createMenu({ workspaceId, actorAdminUserId: adminUserId, key: "site", name: "Site", initialItems: treeItems(targets) });

    expect(await getResolvedNavigationTree({ workspaceId, menuKey: "site" })).toEqual([]); // nothing published yet
    const preview = await getResolvedNavigationTree({ workspaceId, menuKey: "site", mode: "preview" });
    expect(preview).toEqual([
      {
        id: "home", label: "Home", url: "https://example.test/", openInNewTab: true, audienceRule: "all",
        children: [
          { id: "about", label: "About", url: "/about", openInNewTab: false, audienceRule: "all", children: [] },
          { id: "members", label: "Members", url: "/members", openInNewTab: false, audienceRule: "authenticated", children: [] },
        ],
      },
      { id: "contact", label: "Contact", url: "/contact", openInNewTab: false, audienceRule: "all", children: [] },
      { id: "orphan", label: "Orphan", url: `/entry/${targets.otherEntryId}`, openInNewTab: false, audienceRule: "all", children: [] },
    ]);

    await publishMenu({ workspaceId, actorAdminUserId: adminUserId, menuId: menu.id });
    const french = await getResolvedNavigationTree({ workspaceId, menuKey: menu.id, locale: "fr", audience: "guest" });
    expect(french[0]).toMatchObject({ label: "Accueil", children: [{ id: "about", url: "/a-propos" }] });
    record(backend.name, "trees", { preview, french });
  });

  it("finds the menus that link to an entry at any depth", async () => {
    const { workspaceId, adminUserId } = await backend.createWorkspace();
    const targets = await seedTargets(backend, workspaceId);
    const { menu } = await createMenu({ workspaceId, actorAdminUserId: adminUserId, key: "deep", name: "Deep", initialItems: treeItems(targets) });
    await createMenu({ workspaceId, actorAdminUserId: adminUserId, key: "empty", name: "Empty" });
    expect(await getNavigationWhereUsed(workspaceId, targets.entryId)).toEqual([{ menuId: menu.id, menuKey: "deep", menuName: "Deep" }]);
    expect(await getNavigationWhereUsed(workspaceId, targets.otherEntryId)).toHaveLength(1);
    const { entryId: unused } = await backend.createEntry(workspaceId);
    expect(await getNavigationWhereUsed(workspaceId, unused)).toEqual([]);
  });

  it("writes an audit event for each change", async () => {
    const { workspaceId, adminUserId } = await backend.createWorkspace();
    const { menu } = await createMenu({ workspaceId, actorAdminUserId: adminUserId, key: "audited", name: "Audited" });
    await saveMenuDraft({ workspaceId, actorAdminUserId: adminUserId, menuId: menu.id, items: [] });
    const events = await backend.query<{ action: string }>(
      "select action from platform_audit_events where workspace_id = $1 and entity_type = 'navigation_menu' order by created_at, action",
      [workspaceId],
    );
    expect(events.map((e) => e.action)).toEqual(expect.arrayContaining(["navigation.menu.created", "navigation.menu.draft_saved"]));
  });

  it("keeps workspaces isolated", async () => {
    const a = await backend.createWorkspace();
    const b = await backend.createWorkspace();
    const { menu } = await createMenu({ workspaceId: a.workspaceId, actorAdminUserId: a.adminUserId, key: "private", name: "Private" });
    expect(await listMenus(b.workspaceId)).toEqual([]);
    expect(await getMenu(b.workspaceId, menu.id)).toBeNull();
    expect(await getMenu(b.workspaceId, "private")).toBeNull();
    expect(await listMenuVersions(b.workspaceId, menu.id)).toEqual([]);
    await expect(saveMenuDraft({ workspaceId: b.workspaceId, actorAdminUserId: b.adminUserId, menuId: menu.id, items: [] })).rejects.toThrow("Menu not found");
    await expect(publishMenu({ workspaceId: b.workspaceId, actorAdminUserId: b.adminUserId, menuId: menu.id })).rejects.toThrow();
    expect(await getResolvedNavigationTree({ workspaceId: b.workspaceId, menuKey: menu.id, mode: "preview" })).toEqual([]);
    actor.workspaceId = b.workspaceId;
    actor.adminUserId = b.adminUserId;
    await deleteMenuRoute(req(), params({ id: menu.id }));
    expect((await getMenu(a.workspaceId, menu.id))?.name).toBe("Private");
  });

  it("serves the navigation routes end to end", async () => {
    const { workspaceId, adminUserId } = await backend.createWorkspace();
    actor.workspaceId = workspaceId;
    actor.adminUserId = adminUserId;

    const created = await json(await createMenuRoute(req({ key: "route-menu", name: "Route menu", initialItems: [] })));
    expect(created.status).toBeLessThan(300);
    const id = created.body.data.menu.id as string;
    expect((await json(await listMenusRoute(req()))).body.data.map((m: { id: string }) => m.id)).toEqual([id]);

    const renamed = await json(await updateMenuRoute(req({ name: " Renamed ", description: " Desc " }), params({ id })));
    expect(renamed).toMatchObject({ status: 200, body: { data: { menu: { name: "Renamed", description: "Desc" } } } });
    const saved = await json(await updateMenuRoute(req({ items: [{ id: "x", label: "X", itemType: "external_url", url: "/x" }] }), params({ id })));
    expect(saved).toMatchObject({ status: 200, body: { data: { version: { version_number: 2 } } } });
    expect(await json(await publishRoute(req({}), params({ id })))).toMatchObject({ status: 200, body: { data: { state: "published" } } });
    expect(await json(await treeRoute(req(undefined, "http://cms.test/api/navigation?locale=en"), params({ id: "route-menu" })))).toMatchObject({
      status: 200, body: { data: [{ id: "x", url: "/x" }] },
    });
    const detail = await json(await getMenuRoute(req(), params({ id })));
    expect(detail.body.data.versions).toHaveLength(2);
    expect(detail.body.data.currentPublished.version_number).toBe(2);

    expect(await json(await getMenuRoute(req(), params({ id: "not-a-uuid" })))).toMatchObject({ status: 404 });
    // Database errors reach the caller only as the route's fallback text.
    for (const response of [
      await createMenuRoute(req({ key: "route-menu", name: "Duplicate key" })),
      await deleteMenuRoute(req(), params({ id: "not-a-uuid" })),
      await publishRoute(req({ versionNumber: 99 }), params({ id })),
    ]) {
      const { status, body } = await json(response);
      expect(status).toBeGreaterThanOrEqual(400);
      expect(body.error).not.toMatch(/duplicate key|violates|invalid input syntax|relation "|SQLSTATE|PGRST/i);
    }

    expect(await json(await deleteMenuRoute(req(), params({ id })))).toMatchObject({ status: 200, body: { data: { ok: true } } });
    expect(await getMenu(workspaceId, id)).toBeNull();
    const deleted = await backend.query("select 1 from platform_audit_events where workspace_id = $1 and action = 'navigation.menu.deleted'", [workspaceId]);
    expect(deleted).toHaveLength(1);
  });
});

describe("navigation backends agree", () => {
  afterAll(() => vi.restoreAllMocks());
  it("returns identical shapes and values on supabase and postgres", () => {
    expect(recorded.supabase).toBeDefined();
    expect(recorded.postgres).toEqual(recorded.supabase);
  });
});
