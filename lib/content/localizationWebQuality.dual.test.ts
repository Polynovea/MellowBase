import { describe, expect, it } from "vitest";
import { describeBothBackends, type BackendFixtures } from "@/lib/db/testing/dualBackend";
import { createRecorder } from "@/lib/db/testing/compare";
import { createEntry } from "@/lib/content/entryService";
import { configureLocale, getLocalizationStatus, markTranslationsStale, reviewTranslation, setTranslation } from "@/lib/content/localizationService";
import { getSitemapEntries, getWebQualityPolicy, runSiteDiscoverabilityAudit, saveWebQualityPolicy } from "@/lib/content/webQualityService";
import { createModel } from "@/lib/schema/modelService";

const recorder = createRecorder();

async function setup(backend: BackendFixtures) {
  const { workspaceId, adminUserId } = await backend.createWorkspace();
  const model = await createModel({ workspaceId, createdBy: adminUserId, proposedSchema: { name: "Page", apiKey: "page", fields: [{ key: "title", label: "Title", type: "text", required: true }] } });
  if (!model.ok) throw new Error(model.error);
  const make = async (title: string, locale = "en") => {
    const entry = await createEntry({ workspaceId, modelId: model.data.model.id, data: { title }, locale, actorAdminUserId: adminUserId });
    if (!entry.ok) throw new Error(entry.error);
    return { id: entry.data.entry.id, versionId: entry.data.version.id };
  };
  return { workspaceId, adminUserId, make };
}

const stable = <T extends Record<string, unknown>>(row: T, drop: string[]) => Object.fromEntries(Object.entries(row).filter(([key]) => !drop.includes(key)));

describeBothBackends(["content", "schema"], "localization writes and web-quality reads", (backend) => {
  it("configures locales, links, reviews and marks translations stale, scoped to the workspace", async () => {
    const { workspaceId, adminUserId, make } = await setup(backend);
    await configureLocale({ workspaceId, actorId: adminUserId, locale: "en", isDefault: true });
    const hi = await configureLocale({ workspaceId, actorId: adminUserId, locale: "hi", fallbackLocale: "en" });
    expect(hi).toMatchObject({ locale: "hi", fallback_locale: "en", enabled: true });
    await expect(configureLocale({ workspaceId, actorId: adminUserId, locale: "fr", fallbackLocale: "fr" })).rejects.toThrow("A locale cannot fall back to itself");

    const source = await make("Hello");
    const wrongLocale = await make("Bonjour");
    const translated = await make("Namaste", "hi");
    await expect(setTranslation({ workspaceId, actorId: adminUserId, sourceEntryId: source.id, locale: "hi", translatedEntryId: wrongLocale.id })).rejects.toThrow("must be authored in locale hi");

    const link = await setTranslation({ workspaceId, actorId: adminUserId, sourceEntryId: source.id, locale: "hi", translatedEntryId: translated.id });
    expect(link).toMatchObject({ workspace_id: workspaceId, source_entry_id: source.id, locale: "hi", translated_entry_id: translated.id, source_version_id: source.versionId, stale_at: null });
    expect(link.reviewed_at).not.toBeNull();

    await expect(reviewTranslation({ workspaceId, actorId: adminUserId, sourceEntryId: source.id, locale: "hi" })).rejects.toThrow("must pass editorial approval");
    await backend.query("update content_entries set status = 'approved' where id = $1", [translated.id]);
    const reviewed = await reviewTranslation({ workspaceId, actorId: adminUserId, sourceEntryId: source.id, locale: "hi" });
    expect(reviewed).toMatchObject({ id: link.id, source_version_id: source.versionId, stale_at: null });

    // Another workspace can neither read nor touch the link.
    const other = await backend.createWorkspace();
    await expect(reviewTranslation({ workspaceId: other.workspaceId, actorId: other.adminUserId, sourceEntryId: source.id, locale: "hi" })).rejects.toThrow("Source entry draft not found");
    await markTranslationsStale(other.workspaceId, source.id);

    // The source moves on: the link points at an older version and is marked stale.
    await backend.query("update content_entry_translations set source_version_id = $1 where id = $2", [translated.versionId, link.id]);
    await markTranslationsStale(workspaceId, source.id);
    const [after] = await backend.query<{ stale_at: string | null }>("select stale_at from content_entry_translations where id = $1", [link.id]);
    expect(after.stale_at).not.toBeNull();
    const status = await getLocalizationStatus(workspaceId, source.id);
    expect(status?.find((row) => row.locale === "hi")).toMatchObject({ status: "stale", translatedEntryId: translated.id });

    const events = await backend.query<{ action: string }>("select action from platform_audit_events where workspace_id = $1 and action like 'localization.translation_%' order by action", [workspaceId]);
    expect(events.map((e) => e.action)).toEqual(["localization.translation_linked", "localization.translation_reviewed"]);
    recorder.record(backend.name, "link", { link: Object.keys(link).sort(), reviewed: Object.keys(reviewed).sort(), hi: Object.keys(hi as object).sort() });
  });

  it("saves the web-quality policy and builds the sitemap and site audit from workspace rows only", async () => {
    const { workspaceId, adminUserId, make } = await setup(backend);
    const saved = await saveWebQualityPolicy({ workspaceId, actorId: adminUserId, siteBaseUrl: "https://example.test", siteName: "Example", aiCrawlerPolicy: { gptbot: "disallow" }, mediaBudget: { maxImageKb: 300 }, settings: { robotsExtra: "" } });
    expect(saved).toMatchObject({ workspace_id: workspaceId, site_base_url: "https://example.test", site_name: "Example", ai_crawler_policy: { gptbot: "disallow" }, media_budget_json: { maxImageKb: 300 } });
    expect((await getWebQualityPolicy(workspaceId)).site_base_url).toBe("https://example.test");

    const published = await make("Published");
    const draft = await make("Draft");
    await backend.query("update content_entries set status = 'published' where id = $1", [published.id]);
    await backend.query(
      `insert into content_routes (workspace_id, entry_id, locale, path, title, indexing_policy, sitemap_included, sitemap_priority, sitemap_changefreq) values
        ($1, $2, 'en', '/published', 'Published', 'inherit', true, 0.8, 'weekly'),
        ($1, $3, 'en', '/draft', 'Draft', 'inherit', true, null, null),
        ($1, null, 'en', '/hidden', 'Hidden', 'noindex', true, null, null)`,
      [workspaceId, published.id, draft.id],
    );
    await backend.query("insert into content_redirects (workspace_id, locale, source_path, target_path) values ($1, 'en', '/old', '/published')", [workspaceId]);

    const sitemap = await getSitemapEntries(workspaceId);
    expect(sitemap.entries.map((entry) => entry.url)).toEqual(["https://example.test/published"]);
    expect(sitemap.entries[0]).toMatchObject({ entryId: published.id, priority: 0.8, changefreq: "weekly" });

    const audit = await runSiteDiscoverabilityAudit(workspaceId);
    expect(audit.findings.map((f) => f.code)).toContain("seo.noindex_in_sitemap");
    expect(audit.summary.routes).toBe(3);

    // A second workspace sees none of it.
    const other = await backend.createWorkspace();
    expect((await getSitemapEntries(other.workspaceId)).entries).toEqual([]);
    expect((await runSiteDiscoverabilityAudit(other.workspaceId)).summary.routes).toBe(0);

    recorder.record(backend.name, "web quality", {
      policy: stable(saved as unknown as Record<string, unknown>, ["id", "workspace_id", "updated_by", "created_at", "updated_at"]),
      sitemap: sitemap.entries.map((entry) => stable(entry as unknown as Record<string, unknown>, ["routeId", "entryId", "lastModified"])),
      audit: { status: audit.status, summary: audit.summary, codes: audit.findings.map((f) => f.code).sort() },
    });
  });
});

describe("localization and web-quality backends agree", () => {
  it("returns identical shapes and values on supabase and postgres", () => recorder.expectAgreement());
});
