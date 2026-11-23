import { describe, expect, it } from "vitest";
import { describeBothBackends, type BackendFixtures } from "@/lib/db/testing/dualBackend";
import { createRecorder } from "@/lib/db/testing/compare";
import { createEntry } from "@/lib/content/entryService";
import { getAssetUsageGraph, getDependencies, getDependents, getImpact } from "@/lib/content/impactGraphService";
import { createRelease } from "@/lib/content/releaseService";
import { createModel } from "@/lib/schema/modelService";

const recorder = createRecorder();

async function graph(backend: BackendFixtures) {
  const { workspaceId, adminUserId } = await backend.createWorkspace();
  await backend.query("insert into workspace_members (workspace_id, admin_user_id) values ($1, $2)", [workspaceId, adminUserId]);
  const model = await createModel({ workspaceId, createdBy: adminUserId, proposedSchema: { name: "Page", apiKey: "page", fields: [{ key: "title", label: "Title", type: "text", required: true }] } });
  if (!model.ok) throw new Error(model.error);
  const make = async (title: string) => {
    const entry = await createEntry({ workspaceId, modelId: model.data.model.id, data: { title }, actorAdminUserId: adminUserId });
    if (!entry.ok) throw new Error(entry.error);
    return { id: entry.data.entry.id, versionId: entry.data.version.id };
  };
  const target = await make("Target");
  const source = await make("Source");
  const [asset] = await backend.query<{ id: string }>(
    "insert into assets (workspace_id, filename, mime_type, size_bytes, storage_key, storage_provider, checksum) values ($1, 'hero.png', 'image/png', 10, $2, 'local', 'abc') returning id",
    [workspaceId, `ws/${workspaceId}/hero.png`],
  );
  const [menu] = await backend.query<{ id: string }>("insert into navigation_menus (workspace_id, key, name) values ($1, 'main', 'Main menu') returning id", [workspaceId]);
  const [route] = await backend.query<{ id: string }>("insert into content_routes (workspace_id, entry_id, locale, path, title) values ($1, $2, 'en', '/target', 'Target') returning id", [workspaceId, target.id]);
  await backend.query("insert into content_relations (workspace_id, source_entry_id, source_version_id, source_field_key, target_entry_id) values ($1, $2, $3, 'related', $4)", [workspaceId, source.id, source.versionId, target.id]);
  await backend.query("insert into content_relations (workspace_id, source_entry_id, source_version_id, source_field_key, target_asset_id) values ($1, $2, $3, 'hero', $4)", [workspaceId, source.id, source.versionId, asset.id]);
  await backend.query("insert into content_relations (workspace_id, source_menu_id, source_field_key, target_entry_id) values ($1, $2, 'menu_item', $3)", [workspaceId, menu.id, target.id]);
  await backend.query("insert into content_relations (workspace_id, source_menu_id, source_field_key, target_route_id) values ($1, $2, 'menu_item', $3)", [workspaceId, menu.id, route.id]);
  await backend.query("insert into content_relations (workspace_id, source_menu_id, source_field_key, target_asset_id) values ($1, $2, 'menu_icon', $3)", [workspaceId, menu.id, asset.id]);

  await backend.query("update content_entries set status = 'approved' where id = $1", [target.id]);
  const release = await createRelease({ workspaceId, actorId: adminUserId, name: "Launch", itemVersionIds: [target.versionId] });
  if (!release.ok) throw new Error(release.error);
  return { workspaceId, target, source, assetId: asset.id, menuId: menu.id, routeId: route.id, releaseId: (release.data as { id: string }).id };
}

describeBothBackends(["content", "schema"], "dependency, impact and asset usage graph", (backend) => {
  it("reads dependencies, dependents, impact and asset usage within the workspace", async () => {
    const g = await graph(backend);

    const dependencies = await getDependencies(g.workspaceId, g.source.id);
    expect(dependencies).toEqual(expect.arrayContaining([
      expect.objectContaining({ targetType: "entry", targetId: g.target.id, field: "related", status: "approved", active: true }),
      expect.objectContaining({ targetType: "asset", targetId: g.assetId, field: "hero" }),
    ]));
    expect(dependencies).toHaveLength(2);

    const dependents = await getDependents(g.workspaceId, g.target.id);
    expect(dependents).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceType: "entry", entryId: g.source.id, field: "related", status: "draft" }),
      expect.objectContaining({ sourceType: "menu", entryId: g.menuId, field: "menu_item" }),
    ]));
    expect(dependents?.filter((edge) => edge.sourceType === "release")).toHaveLength(1); // the release item's own edge

    const impact = await getImpact(g.workspaceId, g.target.id);
    expect(impact?.releaseIds).toEqual([g.releaseId]);
    expect(impact?.destinations).toEqual([{ routeId: g.routeId, path: "/target", locale: "en", canonical: true, indexingPolicy: "inherit", dependentSources: [{ sourceType: "menu", sourceId: g.menuId, relationType: expect.any(String) }] }]);
    expect(impact?.totalImpact).toBe((dependents?.length ?? 0) + 1 + 1);

    const usage = await getAssetUsageGraph(g.workspaceId, g.assetId);
    expect(usage).toEqual(expect.arrayContaining([
      { entryId: g.source.id, versionId: g.source.versionId, title: "Source", fieldKey: "hero", status: "draft", isPublished: false },
      { entryId: g.menuId, versionId: g.menuId, title: "Main menu", fieldKey: "menu_icon", status: "active", isPublished: true },
    ]));
    expect(usage).toHaveLength(2);
    expect(await getAssetUsageGraph(g.workspaceId, "not-a-uuid")).toEqual([]);

    // Another workspace sees no entry, no edges and no usage.
    const other = await backend.createWorkspace();
    expect(await getDependencies(other.workspaceId, g.source.id)).toBeNull();
    expect(await getDependents(other.workspaceId, g.target.id)).toBeNull();
    expect(await getImpact(other.workspaceId, g.target.id)).toBeNull();
    expect(await getAssetUsageGraph(other.workspaceId, g.assetId)).toEqual([]);

    const sortEdges = <T extends { entryId: string; field: string }>(edges: T[] | null) => [...(edges ?? [])].map((e) => ({ ...e, entryId: e.entryId === g.menuId ? "menu" : e.entryId === g.source.id ? "source" : e.entryId === g.target.id ? "target" : e.entryId === g.assetId ? "asset" : "release", targetId: undefined })).sort((a, b) => `${a.entryId}${a.field}`.localeCompare(`${b.entryId}${b.field}`));
    recorder.record(backend.name, "graph", {
      dependencies: sortEdges(dependencies),
      dependents: sortEdges(dependents),
      impact: { sourceTypeCounts: impact?.sourceTypeCounts, publishedDependents: impact?.publishedDependents, totalImpact: impact?.totalImpact, destinations: impact?.destinations.length },
      usage: usage.map((u) => ({ title: u.title, fieldKey: u.fieldKey, status: u.status, isPublished: u.isPublished })).sort((a, b) => a.title.localeCompare(b.title)),
    });
  });
});

describe("impact graph backends agree", () => {
  it("returns identical shapes and values on supabase and postgres", () => recorder.expectAgreement());
});
