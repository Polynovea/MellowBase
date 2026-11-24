// Phase 3, wave 3: search before and after a model's reads move to its table.
//
// Model-scoped search on a switched model matches by trigram and substring on the table's
// search-indexed text columns (pg_trgm indexes) and by full text on content_search_documents; ranking
// and cross-model search stay on content_search_documents. Each query below runs before and after the
// switch; the results must be equal except for the query types the split is known to change, which
// the test names and reports.
import { randomUUID } from "node:crypto";
import { afterAll, expect, it, vi } from "vitest";
import { describeWithDatabase } from "@/lib/db/testing/database";
import { getDb } from "@/lib/db/index";
import { createEntry } from "@/lib/content/entryService";
import { searchContent } from "@/lib/content/searchService";
import { setReadSource } from "@/lib/content/contentMove";
import { bringModelTableUp, closeTableMoveSession } from "@/lib/content/testing/tableMove";
import { uniqueKey } from "@/lib/schema/engine/testing";
import { createModel } from "@/lib/schema/modelService";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 60_000 });

afterAll(async () => { await closeTableMoveSession(); });

const DOCS: Array<Record<string, unknown>> = [
  { title: "Kubernetes guide", body: "Containers and pods for beginners", slug: "kube-guide", tags: ["ops"] },
  { title: "Gardening tips", body: "Tomatoes need sun", slug: "garden-tips", tags: ["home"] },
  { title: "Kubernetes FAQ", body: "Pods restart when probes fail", slug: "kube-faq-2", tags: ["ops", "faq"] },
  { title: "Release notes", body: "The guide moved to the docs site", slug: "release-notes", tags: [] },
  { title: "Baking bread", body: "Sourdough starter basics", slug: "bread", tags: ["kitchenware"] },
  { title: "Ünïcödé “quotes”", body: "Café crème", slug: "unicode", tags: [] },
];

/** Query → why its results may differ after the switch (absent: they must be equal). */
const QUERIES: Array<{ q: string; known?: string }> = [
  { q: "kubernetes" },
  { q: "pods" },
  { q: "Kubernet" },
  { q: "kubernets", known: "typo_scored_per_field_not_per_document" },
  { q: "tomatoes" },
  { q: "sourdough starter" },
  { q: "café" },
  { q: "guide" },
  { q: "nothing matches this" },
  { q: "guide containers", known: "phrase_spans_two_fields" },
  { q: "faq-2", known: "substring_of_non_search_indexed_text_field" },
  { q: "kitchenwa", known: "substring_inside_json_or_list_field" },
];

describeWithDatabase("search before and after a model's reads move to its table", (backend) => {
  it("returns the same results, except the query types the split is known to change", async () => {
    const { workspaceId, adminUserId } = await backend.createWorkspace();
    await backend.query("insert into workspace_members (workspace_id, admin_user_id, status) values ($1, $2, 'active')", [workspaceId, adminUserId]);
    const model = await createModel({
      workspaceId, createdBy: adminUserId, proposedSchema: {
        name: "Doc", apiKey: uniqueKey("doc"), fields: [
          { key: "title", label: "Title", type: "text", required: true },
          { key: "body", label: "Body", type: "long_text" },
          { key: "slug", label: "Slug", type: "slug" },
          { key: "tags", label: "Tags", type: "multi_select" },
        ],
      },
    });
    if (!model.ok) throw new Error(model.error);
    const modelId = model.data.model.id;
    for (const data of DOCS) {
      const created = await createEntry({ workspaceId, modelId, data, actorAdminUserId: adminUserId });
      if (!created.ok) throw new Error(created.error);
    }
    const run = async (q: string, scoped = true) =>
      (await searchContent({ workspaceId, query: q, modelId: scoped ? modelId : undefined })).map((hit: { entry_id: string | null }) => String(hit.entry_id));

    const before = new Map<string, string[]>();
    for (const { q } of QUERIES) before.set(q, await run(q));
    const globalBefore = await run("kubernetes", false);

    const up = await bringModelTableUp({ workspaceId, modelId, actor: adminUserId, switchReads: true });
    expect(up.verify.matched).toBe(true);

    const differing: Array<{ q: string; known: string | null; before: number; after: number }> = [];
    for (const { q, known } of QUERIES) {
      const after = await run(q);
      if (JSON.stringify(after) !== JSON.stringify(before.get(q))) differing.push({ q, known: known ?? null, before: before.get(q)!.length, after: after.length });
    }
    console.log(`[content-move] search_differences ${JSON.stringify({ queries: QUERIES.length, differing })}`);
    // Only known query types may differ. A typo is scored against one field instead of the whole
    // document, so it can find more; a substring outside the search-indexed text fields finds less.
    expect(differing.filter((d) => !d.known)).toEqual([]);
    // Cross-model search is unchanged.
    expect(await run("kubernetes", false)).toEqual(globalBefore);

    // Rolling the model back restores the previous search exactly.
    await setReadSource(getDb(), { workspaceId, modelId, source: "snapshot" });
    for (const { q } of QUERIES) expect({ q, hits: await run(q) }).toEqual({ q, hits: before.get(q) });
  });

  it("matches only the table row of the document's own version: no draft text through a published document, no other locale", async () => {
    const { workspaceId, adminUserId } = await backend.createWorkspace();
    await backend.query("insert into workspace_members (workspace_id, admin_user_id, status) values ($1, $2, 'active')", [workspaceId, adminUserId]);
    const model = await createModel({
      workspaceId, createdBy: adminUserId, proposedSchema: {
        name: "Page", apiKey: uniqueKey("page"), fields: [{ key: "title", label: "Title", type: "text", required: true }],
      },
    });
    if (!model.ok) throw new Error(model.error);
    const modelId = model.data.model.id;
    // Each entry: a published version in English and a newer draft; its search document is the
    // published version (status published). The draft holds a word the published text does not.
    const entries = [
      { id: randomUUID(), published: "Alpha harbour", draft: "Alpha zygomorphic", draftLocale: "en" },
      { id: randomUUID(), published: "Beta lighthouse", draft: "Beta quixotry", draftLocale: "hi" },
      { id: randomUUID(), published: "Gamma zygomorphic", draft: "Gamma", draftLocale: "en" },
    ];
    for (const entry of entries) {
      const publishedId = randomUUID();
      const draftId = randomUUID();
      await backend.query("insert into content_entries (id, workspace_id, content_model_id, status) values ($1, $2, $3, 'published')", [entry.id, workspaceId, modelId]);
      await backend.query(
        `insert into content_entry_versions (id, entry_id, model_schema_version, version_number, data_jsonb, locale, state)
         values ($1, $3, 1, 1, $4, 'en', 'published'), ($2, $3, 1, 2, $5, $6, 'draft')`,
        [publishedId, draftId, entry.id, JSON.stringify({ title: entry.published }), JSON.stringify({ title: entry.draft }), entry.draftLocale]);
      await backend.query("update content_entries set published_version_id = $1, current_draft_version_id = $2 where id = $3", [publishedId, draftId, entry.id]);
      await backend.query(
        `insert into content_search_documents (entry_id, workspace_id, version_id, content_model_id, locale, status, search_text)
         values ($1, $2, $3, $4, 'en', 'published', $5)`,
        [entry.id, workspaceId, publishedId, modelId, entry.published]);
    }
    expect((await bringModelTableUp({ workspaceId, modelId, actor: adminUserId, switchReads: true })).verify.matched).toBe(true);
    const hits = async (q: string, locale?: string) =>
      (await searchContent({ workspaceId, query: q, modelId, locale })).map((hit: { entry_id: string | null }) => String(hit.entry_id)).sort();

    // A word only in a draft: found through the published document whose own text has it, never
    // through another entry's draft row.
    expect(await hits("zygomorphic")).toEqual([entries[2].id]);
    expect(await hits("zygomorph")).toEqual([entries[2].id]);
    // A word only in a draft in another locale: not found, with or without a locale filter.
    expect(await hits("quixotry")).toEqual([]);
    expect(await hits("quixotr", "en")).toEqual([]);
    // The published text itself is still found by substring and trigram on the table.
    expect(await hits("lighthous")).toEqual([entries[1].id]);
  });
});
