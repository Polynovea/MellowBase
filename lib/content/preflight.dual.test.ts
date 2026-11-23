import { describe, expect, it } from "vitest";
import { describeWithDatabase } from "@/lib/db/testing/database";
import { createEntry, saveDraft } from "@/lib/content/entryService";
import { runEntryPreflight, runVersionPreflight } from "@/lib/content/preflightService";
import { getLocalizationStatus, listLocales } from "@/lib/content/localizationService";
import { getWebQualityPolicy } from "@/lib/content/webQualityService";
import { createModel } from "@/lib/schema/modelService";

describeWithDatabase("preflight and destination assurance", (backend) => {
  it("produces the same readiness report from the same rows", async () => {
    const { workspaceId, adminUserId } = await backend.createWorkspace();
    const model = await createModel({
      workspaceId, createdBy: adminUserId, proposedSchema: {
        name: "Page", apiKey: "page", fields: [
          { key: "title", label: "Title", type: "text", required: true },
          { key: "slug", label: "Slug", type: "text", unique: true },
          { key: "meta_description", label: "Description", type: "text" },
        ],
      },
    });
    if (!model.ok) throw new Error(model.error);
    const modelId = model.data.model.id;
    const page = await createEntry({ workspaceId, modelId, data: { title: "About us", slug: "about", meta_description: "Short" }, actorAdminUserId: adminUserId });
    const twin = await createEntry({ workspaceId, modelId, data: { title: "About us", slug: "about-2" }, actorAdminUserId: adminUserId });
    if (!page.ok || !twin.ok) throw new Error("entries");
    const entryId = page.data.entry.id;

    // Site tree: /company (untitled parent) > /company/about (canonical, also a redirect source).
    const [parent] = await backend.query<{ id: string }>("insert into content_routes (workspace_id, path, locale) values ($1, '/company', 'en') returning id", [workspaceId]);
    await backend.query("insert into content_routes (workspace_id, entry_id, parent_route_id, path, locale, title, is_canonical, indexing_policy, sitemap_included) values ($1, $2, $3, '/company/about', 'en', 'About', true, 'noindex', true)", [workspaceId, entryId, parent.id]);
    await backend.query("insert into content_redirects (workspace_id, source_path, target_path) values ($1, '/company/about', '/elsewhere')", [workspaceId]);
    await backend.query("insert into workspace_locales (workspace_id, locale, enabled, required, is_default) values ($1, 'en', true, true, true), ($1, 'fr', true, true, false)", [workspaceId]);

    const report = await runEntryPreflight(workspaceId, entryId);
    expect(report).not.toBeNull();
    const byRule = new Map(report!.results.map((r) => [r.rule_id, r.status]));
    expect(byRule.get("destination.canonical_route")).toBe("pass");
    expect(byRule.get("destination.redirect_collision")).toBe("fail");
    expect(byRule.get("seo.noindex_sitemap_conflict")).toBe("fail");
    expect(byRule.get("navigation.breadcrumb_untitled")).toBe("warning");
    expect(byRule.get("seo.duplicate_title")).toBe("warning");
    expect(byRule.get("localization.required_readiness")).toBe("fail");
    expect(report!.status).toBe("blocked");
    expect(report!.destinations).toEqual([expect.objectContaining({ path: "/company/about", canonical: true, locale: "en" })]);

    // A version preflight of an older version; and the sibling-uniqueness check on drafts.
    const saved = await saveDraft({ workspaceId, entryId, data: { title: "About us", slug: "about-2" }, actorAdminUserId: adminUserId });
    expect(saved.ok).toBe(false); // the unique slug belongs to the twin
    const old = await runVersionPreflight({ workspaceId, entryId, versionId: page.data.version.id });
    expect(old?.versionId).toBe(page.data.version.id);

    expect((await listLocales(workspaceId, false)).map((l) => l.locale)).toEqual(["en", "fr"]);
    expect((await getLocalizationStatus(workspaceId, entryId))?.map((l) => [l.locale, l.status])).toEqual([["en", "current"], ["fr", "missing"]]);
    expect((await getWebQualityPolicy(workspaceId)).workspace_id).toBe(workspaceId);
  });

  it("never reads another workspace's entries, versions or routes", async () => {
    const a = await backend.createWorkspace();
    const b = await backend.createWorkspace();
    const model = await createModel({ workspaceId: a.workspaceId, createdBy: a.adminUserId, proposedSchema: { name: "Note", apiKey: "note", fields: [{ key: "title", label: "Title", type: "text", required: true }] } });
    if (!model.ok) throw new Error(model.error);
    const entry = await createEntry({ workspaceId: a.workspaceId, modelId: model.data.model.id, data: { title: "Mine" }, actorAdminUserId: a.adminUserId });
    if (!entry.ok) throw new Error(entry.error);
    expect(await runEntryPreflight(b.workspaceId, entry.data.entry.id)).toBeNull();
    expect(await runVersionPreflight({ workspaceId: b.workspaceId, entryId: entry.data.entry.id, versionId: entry.data.version.id })).toBeNull();
    expect(await getLocalizationStatus(b.workspaceId, entry.data.entry.id)).toBeNull();
  });
});
