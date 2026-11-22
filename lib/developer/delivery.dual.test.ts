import { describe, expect, it } from "vitest";
import { describeBothBackends, type BackendFixtures } from "@/lib/db/testing/dualBackend";
import { createRecorder } from "@/lib/db/testing/compare";
import { getPublishedContent, listPublishedContent } from "@/lib/developer/publishedContentService";
import { listDeveloperEntries } from "@/lib/developer/resourceService";
import { createDeveloperApiToken } from "@/lib/developer/apiTokenService";
import { exportWorkspaceData } from "@/lib/developer/exportService";
import { GET as listRoute } from "@/app/api/v1/content/[model]/route";
import { GET as getRoute } from "@/app/api/v1/content/[model]/[id]/route";

const recorder = createRecorder();

/** A published entry whose published version has `data` and `locale`, updated at `updatedAt`. */
async function published(backend: BackendFixtures, workspaceId: string, modelId: string, data: Record<string, unknown>, locale: string, updatedAt: string) {
  const [entry] = await backend.query<{ id: string }>("insert into content_entries (workspace_id, content_model_id) values ($1, $2) returning id", [workspaceId, modelId]);
  const [version] = await backend.query<{ id: string }>(
    "insert into content_entry_versions (entry_id, model_schema_version, version_number, data_jsonb, locale, state) values ($1, 1, 1, $2, $3, 'published') returning id",
    [entry.id, JSON.stringify(data), locale],
  );
  await backend.query("update content_entries set status = 'published', published_version_id = $2, updated_at = $3 where id = $1", [entry.id, version.id, updatedAt]);
  return { entryId: entry.id, versionId: version.id };
}

async function setup(backend: BackendFixtures) {
  const { workspaceId, adminUserId } = await backend.createWorkspace();
  const [model] = await backend.query<{ id: string }>("insert into content_models (workspace_id, name, api_key, status) values ($1, 'Article', 'article', 'active') returning id", [workspaceId]);
  const first = await published(backend, workspaceId, model.id, { title: "First" }, "en", "2026-01-01T00:00:00Z");
  const second = await published(backend, workspaceId, model.id, { title: "Second" }, "en", "2026-02-01T00:00:00Z");
  const french = await published(backend, workspaceId, model.id, { title: "Premier" }, "fr", "2026-03-01T00:00:00Z");
  await backend.query("insert into content_routes (workspace_id, entry_id, path, locale, is_canonical, status) values ($1, $2, '/first', 'en', true, 'active')", [workspaceId, first.entryId]);
  const [draft] = await backend.query<{ id: string }>("insert into content_entries (workspace_id, content_model_id) values ($1, $2) returning id", [workspaceId, model.id]);
  return { workspaceId, adminUserId, modelId: model.id, first, second, french, draftId: draft.id };
}

describeBothBackends("developer", "developer content delivery (published content, entry list)", (backend) => {
  it("serves published content newest first, with canonical routes and locale filters", async () => {
    const { workspaceId, first, second, french } = await setup(backend);
    const all = await listPublishedContent({ workspaceId, modelApiKey: "article" });
    expect(all.records.map((record) => record.data.title)).toEqual(["Premier", "Second", "First"]);
    expect(all.records[2]).toMatchObject({ id: first.entryId, versionId: first.versionId, model: "article", locale: "en", version: 1, route: { path: "/first", locale: "en" } });
    expect(all.records[1].route).toBeNull();
    expect((await listPublishedContent({ workspaceId, modelApiKey: "article", locale: "fr" })).records.map((r) => r.id)).toEqual([french.entryId]);
    expect((await listPublishedContent({ workspaceId, modelApiKey: "article", limit: 1, offset: 1 })).records.map((r) => r.id)).toEqual([second.entryId]);
    expect(await listPublishedContent({ workspaceId, modelApiKey: "missing" })).toEqual({ model: null, records: [] });

    const one = await getPublishedContent({ workspaceId, modelApiKey: "article", entryId: first.entryId });
    expect(one.record).toEqual(all.records[2]);
    expect((await getPublishedContent({ workspaceId, modelApiKey: "article", entryId: first.entryId, locale: "fr" })).record).toBeNull();
    expect((await getPublishedContent({ workspaceId, modelApiKey: "article", entryId: "not-a-uuid" })).record).toBeNull();
    recorder.record(backend.name, "published", { all: all.records, model: all.model });
  });

  it("lists developer entries with their current version", async () => {
    const { workspaceId, draftId, first } = await setup(backend);
    const listed = await listDeveloperEntries({ workspaceId, modelApiKey: "article" });
    expect(listed.rows).toHaveLength(4);
    expect(listed.model).toMatchObject({ api_key: "article" });
    expect(listed.rows.find((row: { id: string }) => row.id === draftId)?.currentVersion).toBeNull();
    expect(listed.rows.find((row: { id: string }) => row.id === first.entryId)?.currentVersion).toMatchObject({ id: first.versionId, locale: "en" });
    expect((await listDeveloperEntries({ workspaceId, status: "published", locale: "fr" })).rows).toHaveLength(1);
    expect(await listDeveloperEntries({ workspaceId, modelApiKey: "missing" })).toMatchObject({ rows: [], model: null });
    recorder.record(backend.name, "entries", { ids: listed.rows.map((row: { id: string }) => row.id), keys: Object.keys(listed.rows[0]).sort() });
  });

  it("exports a workspace's portable state, scoped to that workspace", async () => {
    const a = await setup(backend);
    const b = await setup(backend);
    const exported = await exportWorkspaceData(a.workspaceId);
    expect(exported).toMatchObject({ format: "polynovea-cms-export", formatVersion: 2, workspace: { id: a.workspaceId } });
    expect(exported.schema.models.map((m: { id: string }) => m.id)).toEqual([a.modelId]);
    expect(exported.content.entries.map((e: { id: string }) => e.id).sort()).toEqual([a.first.entryId, a.second.entryId, a.french.entryId, a.draftId].sort());
    expect(exported.content.entryVersions).toHaveLength(3);
    expect(exported.routing.routes).toHaveLength(1);
    const everything = JSON.stringify(exported);
    expect(everything).not.toContain(b.workspaceId);
    expect(everything).not.toContain("token_hash");
    recorder.record(backend.name, "export sizes", Object.fromEntries(Object.entries(exported).filter(([, v]) => v && typeof v === "object" && !Array.isArray(v)).map(([k, v]) => [k, Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([kk, vv]) => [kk, Array.isArray(vv) ? vv.length : typeof vv]))])));
  });

  it("exports every row of a large table (the Supabase path stops at 1000)", async () => {
    const { workspaceId, adminUserId } = await backend.createWorkspace();
    await backend.query(
      "insert into platform_audit_events (workspace_id, actor_admin_user_id, action, entity_type) select $1, $2, 'probe.bulk', 'probe' from generate_series(1, 1001)",
      [workspaceId, adminUserId],
    );
    const exported = await exportWorkspaceData(workspaceId);
    // Known Supabase limit, fixed on the direct path: PostgREST returns at most 1000 rows per read.
    expect(exported.platform.auditEvents).toHaveLength(backend.name === "postgres" ? 1001 : 1000);
  });

  it("keeps workspaces isolated, and the v1 routes serve only the token's workspace", async () => {
    const a = await setup(backend);
    const b = await backend.createWorkspace();
    expect((await listPublishedContent({ workspaceId: b.workspaceId, modelApiKey: "article" })).model).toBeNull();
    expect((await getPublishedContent({ workspaceId: b.workspaceId, modelApiKey: "article", entryId: a.first.entryId })).record).toBeNull();
    expect((await listDeveloperEntries({ workspaceId: b.workspaceId })).rows).toEqual([]);

    const { secret } = await createDeveloperApiToken({ workspaceId: a.workspaceId, actorId: a.adminUserId, name: "Delivery", scopes: ["content.read"] });
    const request = (path: string) => new Request(`http://cms.test${path}`, { headers: { authorization: `Bearer ${secret}` } });
    const list = await listRoute(request("/api/v1/content/article?limit=2"), { params: Promise.resolve({ model: "article" }) });
    expect(list.status).toBe(200);
    expect((await list.json()).data.map((r: { data: { title: string } }) => r.data.title)).toEqual(["Premier", "Second"]);
    const single = await getRoute(request(`/api/v1/content/article/${a.first.entryId}`), { params: Promise.resolve({ model: "article", id: a.first.entryId }) });
    expect((await single.json()).data).toMatchObject({ id: a.first.entryId, route: { path: "/first" } });
    expect((await listRoute(request("/api/v1/content/missing"), { params: Promise.resolve({ model: "missing" }) })).status).toBe(404);
  });
});

describe("developer delivery backends agree", () => {
  it("returns identical shapes and values on supabase and postgres", () => recorder.expectAgreement());
});
