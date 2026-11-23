// Phase 3, wave 3: search before and after a model's reads move to its table.
//
// Model-scoped search on a switched model matches by trigram and substring on the table's
// search-indexed text columns (pg_trgm indexes) and by full text on content_search_documents; ranking
// and cross-model search stay on content_search_documents. Each query below runs before and after the
// switch; the results must be equal except for the query types the split is known to change, which
// the test names and reports.
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
  { q: "kubernets" },
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
    // Only known query types may differ, and only by finding less (never a new, unrelated hit).
    expect(differing.filter((d) => !d.known)).toEqual([]);
    for (const d of differing) expect(d.after).toBeLessThanOrEqual(d.before);
    // Cross-model search is unchanged.
    expect(await run("kubernetes", false)).toEqual(globalBefore);

    // Rolling the model back restores the previous search exactly.
    await setReadSource(getDb(), { workspaceId, modelId, source: "snapshot" });
    for (const { q } of QUERIES) expect({ q, hits: await run(q) }).toEqual({ q, hits: before.get(q) });
  });
});
