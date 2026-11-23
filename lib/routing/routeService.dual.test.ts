import { describe, expect, it, vi } from "vitest";
import { describeWithDatabase } from "@/lib/db/testing/database";
import { ISO_TIMESTAMP, jsonRequest, LEAKED_DB_ERROR, readJson, routeParams } from "@/lib/db/testing/http";
import {
  checkPathCollision,
  deleteRoute,
  getRoute,
  getSiteTree,
  listRoutes,
  registerRoute,
  updateRouteDiscoverability,
  updateRoutePath,
} from "@/lib/routing/routeService";
import { GET as listRoute, POST as registerRouteHandler } from "@/app/api/routes/route";
import { DELETE as deleteRouteHandler, GET as getRouteHandler, PUT as updateRouteHandler } from "@/app/api/routes/[id]/route";
import { PUT as discoverabilityHandler } from "@/app/api/routes/[id]/discoverability/route";
import { POST as collisionHandler } from "@/app/api/routes/collision-check/route";
import { GET as treeHandler } from "@/app/api/routes/tree/route";

const actor = vi.hoisted(() => ({ workspaceId: "", adminUserId: "" }));
vi.mock("@/lib/platform/permissions", () => ({
  requirePlatformAccess: vi.fn(async () => ({ data: { actor: { ...actor }, adminUser: { id: actor.adminUserId } } })),
}));

const ROUTE_KEYS = ["created_at", "entry_id", "id", "indexing_policy", "is_canonical", "locale", "metadata_json", "node_type", "order_index", "parent_route_id", "path", "sitemap_changefreq", "sitemap_included", "sitemap_priority", "status", "title", "updated_at", "workspace_id"];

describeWithDatabase("route service", (backend) => {
  it("registers, lists, nests, re-paths and deletes routes with identical shapes", async () => {
    const { workspaceId, adminUserId } = await backend.createWorkspace();
    const { entryId } = await backend.createEntry(workspaceId);

    const parent = await registerRoute({ workspaceId, actorAdminUserId: adminUserId, locale: "en", path: "Docs/", title: " Docs ", nodeType: "virtual_folder", orderIndex: 1 });
    expect(Object.keys(parent).sort()).toEqual(ROUTE_KEYS);
    expect(parent).toMatchObject({ path: "/docs", title: "Docs", node_type: "virtual_folder", is_canonical: true, status: "active", order_index: 1, metadata_json: {}, sitemap_priority: null });
    expect(parent.created_at).toMatch(ISO_TIMESTAMP);

    const child = await registerRoute({ workspaceId, actorAdminUserId: adminUserId, locale: "en", path: "/docs//Intro", entryId, parentRouteId: parent.id, metadata: { note: "x" } });
    const other = await registerRoute({ workspaceId, actorAdminUserId: adminUserId, locale: "fr", path: "/docs/intro", entryId });
    expect(child).toMatchObject({ path: "/docs/intro", entry_id: entryId, parent_route_id: parent.id, metadata_json: { note: "x" } });

    const all = (await listRoutes(workspaceId)).map((r) => `${r.order_index}${r.locale}${r.path}`);
    expect(all.slice(0, 2).sort()).toEqual(["0en/docs/intro", "0fr/docs/intro"]); // same order_index and path: either order
    expect(all[2]).toBe("1en/docs");
    expect((await listRoutes(workspaceId, "fr")).map((r) => r.id)).toEqual([other.id]);
    const tree = await getSiteTree(workspaceId);
    expect(tree.map((r) => r.id)).toEqual([parent.id]);
    expect(tree[0].children?.map((r) => r.id)).toEqual([child.id]);
    expect(await getRoute(workspaceId, child.id)).toMatchObject({ id: child.id, path: "/docs/intro" });
    expect(await getRoute(workspaceId, "not-a-uuid")).toBeNull();

    const moved = await updateRoutePath({ workspaceId, actorAdminUserId: adminUserId, routeId: child.id, newPath: "/docs/start", title: "Start" });
    expect(moved.redirectCreated).toBe(true);
    expect(Object.keys(moved.route).sort()).toEqual(ROUTE_KEYS);
    expect(moved.route).toMatchObject({ id: child.id, path: "/docs/start", title: "Start", parent_route_id: parent.id });
    const redirects = await backend.query("select source_path, target_path, status_code from content_redirects where workspace_id = $1", [workspaceId]);
    expect(redirects).toEqual([expect.objectContaining({ source_path: "/docs/intro", target_path: "/docs/start" })]);

    const discoverable = await updateRouteDiscoverability({ workspaceId, actorAdminUserId: adminUserId, routeId: child.id, indexingPolicy: "noindex", sitemapIncluded: false, sitemapPriority: 0.4, sitemapChangefreq: "weekly" });
    expect(discoverable).toMatchObject({ indexing_policy: "noindex", sitemap_included: false, sitemap_priority: 0.4, sitemap_changefreq: "weekly" });

    expect(await deleteRoute({ workspaceId, actorAdminUserId: adminUserId, routeId: other.id })).toEqual({ ok: true });
    expect(await getRoute(workspaceId, other.id)).toBeNull();
  });

  it("detects collisions on the normalized path and keeps one canonical route per entry and locale", async () => {
    const { workspaceId, adminUserId } = await backend.createWorkspace();
    const { entryId } = await backend.createEntry(workspaceId);
    const first = await registerRoute({ workspaceId, actorAdminUserId: adminUserId, locale: "en", path: "/a", entryId });
    const second = await registerRoute({ workspaceId, actorAdminUserId: adminUserId, locale: "en", path: "/b", entryId });
    expect((await getRoute(workspaceId, first.id))?.is_canonical).toBe(false);
    expect(second.is_canonical).toBe(true);

    const collision = await checkPathCollision({ workspaceId, locale: "en", path: "A/" });
    expect(collision).toMatchObject({ isCollision: true, normalizedPath: "/a", conflictingRoute: { id: first.id } });
    expect(await checkPathCollision({ workspaceId, locale: "en", path: "/a", excludeRouteId: first.id })).toEqual({ isCollision: false, conflictingRoute: null, normalizedPath: "/a" });
    expect(await checkPathCollision({ workspaceId, locale: "fr", path: "/a" })).toMatchObject({ isCollision: false });
    expect(await checkPathCollision({ workspaceId, locale: "en", path: "/api/x" })).toMatchObject({ isCollision: true, error: expect.stringContaining("reserved") });

    await expect(registerRoute({ workspaceId, actorAdminUserId: adminUserId, locale: "en", path: "/A", entryId })).rejects.toThrow("Route collision");
    // The failed registration must not have taken the canonical flag from the existing route.
    expect((await getRoute(workspaceId, second.id))?.is_canonical).toBe(true);
  });

  it("keeps dependency edges and audit events in step", async () => {
    const { workspaceId, adminUserId } = await backend.createWorkspace();
    const { entryId } = await backend.createEntry(workspaceId);
    const route = await registerRoute({ workspaceId, actorAdminUserId: adminUserId, locale: "en", path: "/edge", entryId });
    const edges = () => backend.query<{ relation_type: string }>(
      "select relation_type from content_relations where workspace_id = $1 and source_route_id = $2",
      [workspaceId, route.id],
    );
    expect(await edges()).toEqual([{ relation_type: "route_entry" }]);
    await deleteRoute({ workspaceId, actorAdminUserId: adminUserId, routeId: route.id });
    const events = await backend.query<{ action: string }>(
      "select action from platform_audit_events where workspace_id = $1 and entity_type = 'route' order by action",
      [workspaceId],
    );
    expect(events.map((e) => e.action)).toEqual(expect.arrayContaining(["routing.route.created", "routing.route.deleted"]));
  });

  it("keeps workspaces isolated", async () => {
    const a = await backend.createWorkspace();
    const b = await backend.createWorkspace();
    const route = await registerRoute({ workspaceId: a.workspaceId, actorAdminUserId: a.adminUserId, locale: "en", path: "/private" });
    expect(await listRoutes(b.workspaceId)).toEqual([]);
    expect(await getRoute(b.workspaceId, route.id)).toBeNull();
    expect(await checkPathCollision({ workspaceId: b.workspaceId, locale: "en", path: "/private" })).toMatchObject({ isCollision: false });
    await expect(updateRoutePath({ workspaceId: b.workspaceId, actorAdminUserId: b.adminUserId, routeId: route.id, newPath: "/stolen" })).rejects.toThrow();
    await expect(updateRouteDiscoverability({ workspaceId: b.workspaceId, actorAdminUserId: b.adminUserId, routeId: route.id, indexingPolicy: "noindex", sitemapIncluded: false })).rejects.toThrow();
    await deleteRoute({ workspaceId: b.workspaceId, actorAdminUserId: b.adminUserId, routeId: route.id });
    expect((await getRoute(a.workspaceId, route.id))?.path).toBe("/private");
  });

  it("serves the routing routes end to end without leaking database errors", async () => {
    const { workspaceId, adminUserId } = await backend.createWorkspace();
    actor.workspaceId = workspaceId;
    actor.adminUserId = adminUserId;

    const created = await readJson(await registerRouteHandler(jsonRequest({ path: "/hello", title: "Hello" })));
    expect(created).toMatchObject({ status: 201, body: { data: { path: "/hello" } } });
    const id = created.body.data.id as string;
    expect((await readJson(await listRoute(jsonRequest(undefined, "http://cms.test/api/routes?locale=en")))).body.data).toHaveLength(1);
    expect((await readJson(await treeHandler(jsonRequest(undefined, "http://cms.test/api/routes/tree")))).body.data[0].id).toBe(id);
    expect(await readJson(await getRouteHandler(jsonRequest(), routeParams({ id })))).toMatchObject({ status: 200, body: { data: { id } } });
    expect(await readJson(await getRouteHandler(jsonRequest(), routeParams({ id: "not-a-uuid" })))).toMatchObject({ status: 404 });
    expect(await readJson(await collisionHandler(jsonRequest({ path: "/HELLO" })))).toMatchObject({ status: 200, body: { data: { isCollision: true } } });
    expect(await readJson(await updateRouteHandler(jsonRequest({ path: "/hi" }, "http://cms.test/api/routes/x", "PUT"), routeParams({ id })))).toMatchObject({ status: 200, body: { data: { route: { path: "/hi" } } } });
    expect(await readJson(await discoverabilityHandler(jsonRequest({ indexingPolicy: "index" }, "http://cms.test/api/routes/x", "PUT"), routeParams({ id })))).toMatchObject({ status: 200, body: { data: { indexing_policy: "index" } } });

    for (const response of [
      await registerRouteHandler(jsonRequest({ path: "/x", entryId: "not-a-uuid" })),
      await updateRouteHandler(jsonRequest({ path: "/y" }, "http://cms.test/api/routes/x", "PUT"), routeParams({ id: "not-a-uuid" })),
      await deleteRouteHandler(jsonRequest(), routeParams({ id: "not-a-uuid" })),
      await discoverabilityHandler(jsonRequest({ sitemapPriority: 7 }, "http://cms.test/api/routes/x", "PUT"), routeParams({ id })),
    ]) {
      const { status, body } = await readJson(response);
      expect(status).toBeGreaterThanOrEqual(400);
      expect(body.error).not.toMatch(LEAKED_DB_ERROR);
    }
    expect(await readJson(await deleteRouteHandler(jsonRequest(), routeParams({ id })))).toMatchObject({ status: 200, body: { data: { ok: true } } });
  });
});
