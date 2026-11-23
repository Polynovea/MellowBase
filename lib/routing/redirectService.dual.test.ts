import { describe, expect, it, vi } from "vitest";
import { describeWithDatabase } from "@/lib/db/testing/database";
import { ISO_TIMESTAMP, jsonRequest, LEAKED_DB_ERROR, readJson, routeParams } from "@/lib/db/testing/http";
import {
  createRedirect,
  deleteRedirect,
  detectRedirectLoop,
  getRedirect,
  importRedirects,
  listRedirects,
  updateRedirect,
  validateRedirectTarget,
} from "@/lib/routing/redirectService";
import { registerRoute } from "@/lib/routing/routeService";
import { GET as listHandler, POST as createHandler } from "@/app/api/redirects/route";
import { DELETE as deleteHandler, GET as getHandler, PUT as updateHandler } from "@/app/api/redirects/[id]/route";
import { POST as importHandler } from "@/app/api/redirects/import/route";

const actor = vi.hoisted(() => ({ workspaceId: "", adminUserId: "" }));
vi.mock("@/lib/platform/permissions", () => ({
  requirePlatformAccess: vi.fn(async () => ({ data: { actor: { ...actor }, adminUser: { id: actor.adminUserId } } })),
}));

const REDIRECT_KEYS = ["created_at", "created_by", "description", "id", "is_active", "locale", "source_path", "status_code", "target_path", "updated_at", "workspace_id"];

describeWithDatabase("redirect service", (backend) => {
  it("creates, lists, updates and deletes redirects with identical shapes and history", async () => {
    const { workspaceId, adminUserId } = await backend.createWorkspace();
    const created = await createRedirect({ workspaceId, actorAdminUserId: adminUserId, sourcePath: "Old/", targetPath: " /new ", description: " moved " });
    expect(Object.keys(created).sort()).toEqual(REDIRECT_KEYS);
    expect(created).toMatchObject({ source_path: "/old", target_path: "/new", status_code: 301, is_active: true, locale: null, description: "moved", created_by: adminUserId });
    expect(created.created_at).toMatch(ISO_TIMESTAMP);

    const french = await createRedirect({ workspaceId, actorAdminUserId: adminUserId, sourcePath: "/ancien", targetPath: "https://example.test/x", statusCode: 302, locale: "fr" });
    expect((await listRedirects(workspaceId)).map((r) => r.id)).toEqual([french.id, created.id]);
    expect((await listRedirects(workspaceId, "fr")).map((r) => r.id).sort()).toEqual([created.id, french.id].sort());
    expect((await listRedirects(workspaceId, "de")).map((r) => r.id)).toEqual([created.id]);
    expect(await getRedirect(workspaceId, created.id)).toEqual(created);
    expect(await getRedirect(workspaceId, "not-a-uuid")).toBeNull();

    const updated = await updateRedirect({ workspaceId, actorAdminUserId: adminUserId, id: created.id, targetPath: "/newer", statusCode: 308, isActive: false, description: null });
    expect(updated).toMatchObject({ source_path: "/old", target_path: "/newer", status_code: 308, is_active: false, description: null });
    const history = await backend.query("select old_target_path, new_target_path, old_status_code, new_status_code from content_redirect_history where redirect_id = $1", [created.id]);
    expect(history).toEqual([{ old_target_path: "/new", new_target_path: "/newer", old_status_code: 301, new_status_code: 308 }]);

    expect(await deleteRedirect({ workspaceId, actorAdminUserId: adminUserId, id: french.id })).toEqual({ ok: true });
    expect(await getRedirect(workspaceId, french.id)).toBeNull();
    const events = await backend.query<{ action: string }>("select action from platform_audit_events where workspace_id = $1 and entity_type = 'redirect' order by action", [workspaceId]);
    expect(events.map((e) => e.action)).toEqual(["redirect.created", "redirect.created", "redirect.deleted", "redirect.updated"]);
  });

  it("detects self, circular and over-long redirect chains", async () => {
    const { workspaceId, adminUserId } = await backend.createWorkspace();
    expect(await detectRedirectLoop(workspaceId, "/a", "/A/")).toMatchObject({ isLoop: true, error: expect.stringContaining("Self-redirect") });
    await createRedirect({ workspaceId, actorAdminUserId: adminUserId, sourcePath: "/b", targetPath: "/c" });
    await createRedirect({ workspaceId, actorAdminUserId: adminUserId, sourcePath: "/c", targetPath: "/a" });
    const loop = await detectRedirectLoop(workspaceId, "/a", "/b");
    expect(loop).toMatchObject({ isLoop: true, loopPath: ["/a", "/b", "/c", "/a", "/a"] });
    await expect(createRedirect({ workspaceId, actorAdminUserId: adminUserId, sourcePath: "/a", targetPath: "/b" })).rejects.toThrow("Circular redirect loop");
    expect(await detectRedirectLoop(workspaceId, "/a", "https://elsewhere.test/")).toEqual({ isLoop: false });
    // Inactive and other-locale rules do not count.
    await createRedirect({ workspaceId, actorAdminUserId: adminUserId, sourcePath: "/x", targetPath: "/y", isActive: false });
    expect((await detectRedirectLoop(workspaceId, "/y", "/x")).isLoop).toBe(false);
    await createRedirect({ workspaceId, actorAdminUserId: adminUserId, sourcePath: "/p", targetPath: "/q", locale: "fr" });
    expect((await detectRedirectLoop(workspaceId, "/q", "/p", "de")).isLoop).toBe(false);
    expect((await detectRedirectLoop(workspaceId, "/q", "/p", "fr")).isLoop).toBe(true);

    for (let i = 0; i < 12; i += 1) await createRedirect({ workspaceId, actorAdminUserId: adminUserId, sourcePath: `/hop${i}`, targetPath: `/hop${i + 1}` });
    expect(await detectRedirectLoop(workspaceId, "/start", "/hop0")).toMatchObject({ isLoop: true, error: "Redirect chain exceeds 10 hops" });
  });

  it("validates targets against live routes", async () => {
    const { workspaceId, adminUserId } = await backend.createWorkspace();
    await registerRoute({ workspaceId, actorAdminUserId: adminUserId, locale: "en", path: "/live" });
    expect(await validateRedirectTarget(workspaceId, "/LIVE/")).toEqual({ isBrokenTarget: false, targetType: "internal_route" });
    expect(await validateRedirectTarget(workspaceId, "/live", "fr")).toEqual({ isBrokenTarget: true, targetType: "broken" });
    expect(await validateRedirectTarget(workspaceId, "/gone")).toEqual({ isBrokenTarget: true, targetType: "broken" });
    expect(await validateRedirectTarget(workspaceId, "https://x.test")).toEqual({ isBrokenTarget: false, targetType: "external_url" });
  });

  it("imports in bulk with a dry run, errors per row and an upsert", async () => {
    const { workspaceId, adminUserId } = await backend.createWorkspace();
    await createRedirect({ workspaceId, actorAdminUserId: adminUserId, sourcePath: "/loop-b", targetPath: "/loop-a", locale: "en" });
    const items = [
      { sourcePath: "/one", targetPath: "/1", statusCode: 302, locale: "en" },
      { sourcePath: "/two?x=1", targetPath: "/2" },
      { sourcePath: "/ONE/", targetPath: "/1b", locale: "en" },
      { sourcePath: "/loop-a", targetPath: "/loop-b", locale: "en" },
      { sourcePath: "/three", targetPath: "/3", statusCode: 999, locale: "en", description: " d " },
    ];
    const dry = await importRedirects({ workspaceId, actorAdminUserId: adminUserId, items });
    expect(dry).toMatchObject({ dryRun: true, totalRows: 5, validCount: 2, errorCount: 3, imported: [] });
    expect(dry.errors.map((e) => e.row)).toEqual([2, 3, 4]);
    expect(await listRedirects(workspaceId)).toHaveLength(1);

    const real = await importRedirects({ workspaceId, actorAdminUserId: adminUserId, items, dryRun: false });
    expect(real.imported.map((r) => [r.source_path, r.status_code, r.description]).sort()).toEqual([["/one", 302, null], ["/three", 301, "d"]]);
    const again = await importRedirects({ workspaceId, actorAdminUserId: adminUserId, items: [{ sourcePath: "/one", targetPath: "/uno", locale: "en" }], dryRun: false });
    expect(again.imported[0]).toMatchObject({ id: real.imported.find((r) => r.source_path === "/one")!.id, target_path: "/uno", status_code: 301 });
  });

  it("keeps workspaces isolated", async () => {
    const a = await backend.createWorkspace();
    const b = await backend.createWorkspace();
    const redirect = await createRedirect({ workspaceId: a.workspaceId, actorAdminUserId: a.adminUserId, sourcePath: "/mine", targetPath: "/x" });
    expect(await listRedirects(b.workspaceId)).toEqual([]);
    expect(await getRedirect(b.workspaceId, redirect.id)).toBeNull();
    expect((await detectRedirectLoop(b.workspaceId, "/x", "/mine")).isLoop).toBe(false);
    await expect(updateRedirect({ workspaceId: b.workspaceId, actorAdminUserId: b.adminUserId, id: redirect.id, targetPath: "/stolen" })).rejects.toThrow("Redirect not found");
    await deleteRedirect({ workspaceId: b.workspaceId, actorAdminUserId: b.adminUserId, id: redirect.id });
    expect((await getRedirect(a.workspaceId, redirect.id))?.target_path).toBe("/x");
  });

  it("serves the redirect routes end to end without leaking database errors", async () => {
    const { workspaceId, adminUserId } = await backend.createWorkspace();
    actor.workspaceId = workspaceId;
    actor.adminUserId = adminUserId;
    const created = await readJson(await createHandler(jsonRequest({ sourcePath: "/from", targetPath: "/to" })));
    expect(created.status).toBeLessThan(300);
    const id = created.body.data.id as string;
    expect((await readJson(await listHandler(jsonRequest(undefined, "http://cms.test/api/redirects")))).body.data).toHaveLength(1);
    expect(await readJson(await getHandler(jsonRequest(), routeParams({ id })))).toMatchObject({ status: 200, body: { data: { id } } });
    expect(await readJson(await updateHandler(jsonRequest({ targetPath: "/to2" }, "http://cms.test/api/redirects/x", "PUT"), routeParams({ id })))).toMatchObject({ status: 200, body: { data: { target_path: "/to2" } } });
    expect(await readJson(await importHandler(jsonRequest({ items: [{ sourcePath: "/i", targetPath: "/j" }] })))).toMatchObject({ status: 200, body: { data: { validCount: 1, dryRun: true } } });

    await createHandler(jsonRequest({ sourcePath: "/dup", targetPath: "/z", locale: "en" }));
    for (const response of [
      await createHandler(jsonRequest({ sourcePath: "/dup", targetPath: "/z2", locale: "en" })),
      await updateHandler(jsonRequest({ statusCode: 999 }, "http://cms.test/api/redirects/x", "PUT"), routeParams({ id })),
      await deleteHandler(jsonRequest(), routeParams({ id: "not-a-uuid" })),
    ]) {
      const { status, body } = await readJson(response);
      expect(status).toBeGreaterThanOrEqual(400);
      expect(body.error).not.toMatch(LEAKED_DB_ERROR);
    }
    expect(await readJson(await deleteHandler(jsonRequest(), routeParams({ id })))).toMatchObject({ status: 200 });
  });
});
