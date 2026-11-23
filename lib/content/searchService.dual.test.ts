import { describe, expect, it } from "vitest";
import { describeBothBackends } from "@/lib/db/testing/dualBackend";
import { createRecorder } from "@/lib/db/testing/compare";
import { createEntry } from "@/lib/content/entryService";
import { deleteSavedSearch, listSavedSearches, saveSearch, searchContent } from "@/lib/content/searchService";
import { createModel } from "@/lib/schema/modelService";

const recorder = createRecorder();

describeBothBackends(["content", "schema"], "content search and saved searches", (backend) => {
  it("ranks and filters search results the same way", async () => {
    const { workspaceId, adminUserId } = await backend.createWorkspace();
    const model = await createModel({ workspaceId, createdBy: adminUserId, proposedSchema: { name: "Doc", apiKey: "doc", fields: [{ key: "title", label: "Title", type: "text", required: true }, { key: "body", label: "Body", type: "text" }] } });
    if (!model.ok) throw new Error(model.error);
    const modelId = model.data.model.id;
    for (const [title, body] of [["Kubernetes guide", "containers and pods"], ["Gardening tips", "tomatoes"], ["Kubernetes FAQ", "pods"]]) {
      const created = await createEntry({ workspaceId, modelId, data: { title, body }, actorAdminUserId: adminUserId });
      if (!created.ok) throw new Error(created.error);
    }
    const hits = await searchContent({ workspaceId, query: "kubernetes" });
    expect(hits.map((hit: { search_text: string | null }) => hit.search_text?.split(" ")[0]).sort()).toEqual(["Kubernetes", "Kubernetes"]);
    expect(await searchContent({ workspaceId, query: "pods", modelId, status: "draft", limit: 1 })).toHaveLength(1);
    expect(await searchContent({ workspaceId, modelId: "not-a-uuid" })).toEqual([]);
    expect(await searchContent({ workspaceId, query: "tomatoes", status: "published" })).toEqual([]);
    const sorted = await searchContent({ workspaceId, sort: "updated_asc" });
    expect(sorted).toHaveLength(3);
    recorder.record(backend.name, "search", { hits: hits.map((hit: Record<string, unknown>) => Object.keys(hit).sort()), count: sorted.length });

    const other = await backend.createWorkspace();
    expect(await searchContent({ workspaceId: other.workspaceId, query: "kubernetes" })).toEqual([]);
  });

  it("saves, lists, shares and deletes saved searches per owner", async () => {
    const { workspaceId, adminUserId } = await backend.createWorkspace();
    const suffix = crypto.randomUUID().slice(0, 8);
    const [colleague] = await backend.query<{ id: string }>("insert into admin_users (username, email) values ($1, $2) returning id", [`c-${suffix}`, `c-${suffix}@example.test`]);
    const mine = await saveSearch({ workspaceId, ownerId: adminUserId, name: " Drafts ", query: { status: "draft", tags: ["a"] } });
    expect(mine).toMatchObject({ name: "Drafts", query_json: { status: "draft", tags: ["a"] }, is_shared: false });
    const updated = await saveSearch({ workspaceId, ownerId: adminUserId, name: "Drafts", query: { status: "in_review" }, shared: true });
    expect(updated).toMatchObject({ id: mine.id, is_shared: true, query_json: { status: "in_review" } });
    await saveSearch({ workspaceId, ownerId: colleague.id, name: "Private", query: {} });
    await expect(saveSearch({ workspaceId, ownerId: adminUserId, name: " ", query: {} })).rejects.toThrow("name is required");

    expect((await listSavedSearches(workspaceId, adminUserId)).map((s: { name: string }) => s.name)).toEqual(["Drafts"]);
    expect((await listSavedSearches(workspaceId, colleague.id)).map((s: { name: string }) => s.name).sort()).toEqual(["Drafts", "Private"]);
    await expect(deleteSavedSearch({ workspaceId, ownerId: colleague.id, id: mine.id })).rejects.toThrow("not owned");
    await expect(deleteSavedSearch({ workspaceId, ownerId: adminUserId, id: "not-a-uuid" })).rejects.toThrow();
    expect(await deleteSavedSearch({ workspaceId, ownerId: adminUserId, id: mine.id })).toEqual({ id: mine.id });

    const other = await backend.createWorkspace();
    expect(await listSavedSearches(other.workspaceId, colleague.id)).toEqual([]);
    recorder.record(backend.name, "saved", { keys: Object.keys(mine).sort() });
  });
});

describe("search backends agree", () => {
  it("returns identical shapes and values on supabase and postgres", () => recorder.expectAgreement());
});
