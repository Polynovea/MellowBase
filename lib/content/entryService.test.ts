import { beforeEach, describe, expect, it, vi } from "vitest";

// The service's rules (archived and stale saves, validation, unique values, relations, import
// batches) run here against faked reads; the reads and writes themselves are covered by
// entryService.dual.test.ts.
vi.mock("@/lib/content/entryData", () => ({
  currentVersionsOfModel: vi.fn(async () => []),
  entriesWithModelKeys: vi.fn(async () => []),
  assetsById: vi.fn(async () => []),
  liveRouteIdsByPath: vi.fn(async () => []),
  listEntries: vi.fn(async () => []),
  getEntry: vi.fn(async () => null),
  listEntryVersions: vi.fn(async () => []),
  findEntryVersion: vi.fn(async () => null),
  versionDataByIds: vi.fn(async () => new Map()),
  callEntryFunction: vi.fn(),
}));
vi.mock("@/lib/schema/modelService", () => ({ getModel: vi.fn(), getVersion: vi.fn() }));
vi.mock("@/lib/platform/audit", () => ({
  logPlatformEvent: vi.fn(),
}));
vi.mock("@/lib/content/searchService", () => ({
  indexEntry: vi.fn(),
  searchableText: vi.fn(() => ""),
}));

import * as entryData from "@/lib/content/entryData";
import { getModel, getVersion } from "@/lib/schema/modelService";
import { saveDraft, createEntry, importEntries, archiveEntry, unarchiveEntry } from "@/lib/content/entryService";
import type { CanonicalSchema } from "@/lib/schema/fields/types";

const data = vi.mocked(entryData);
const mockGetModel = vi.mocked(getModel);
const mockGetVersion = vi.mocked(getVersion);

const schema: CanonicalSchema = {
  name: "Widget",
  apiKey: "widget",
  capability: "content_enabled",
  fields: [
    { key: "title", label: "Title", type: "text", required: true, localized: false, unique: false },
    { key: "email", label: "Email", type: "email", required: false, localized: false, unique: true },
    { key: "related", label: "Related", type: "relation", required: false, localized: false, unique: false, relation: { targetModelApiKey: "widget", cardinality: "many_to_one", onDelete: "block" } },
  ],
};

const model = { id: "model-1", workspace_id: "ws-1", name: "Widget", api_key: "widget", description: null, icon: null, status: "active" as const, current_schema_version: 1, settings_json: {}, created_by: "admin-1", created_at: "t", updated_at: "t" };
const version = { id: "version-1", content_model_id: "model-1", version_number: 1, schema_json: schema, schema_hash: "h", change_summary: null, created_by: "admin-1", created_at: "t" };
const entry = { id: "entry-1", workspace_id: "ws-1", content_model_id: "model-1", status: "draft" as const, current_draft_version_id: "ev-1", published_version_id: null, created_by: "admin-1", updated_by: "admin-1", created_at: "t", updated_at: "t", archived_at: null };
const archivedEntry = { ...entry, status: "archived" as const };
const existingVersions = [{ id: "ev-1", entry_id: "entry-1", model_schema_version: 1, version_number: 2, data_jsonb: { title: "Old" }, locale: "en", state: "draft" as const, created_by: "admin-1", created_at: "t", change_summary: null }];

beforeEach(() => {
  vi.clearAllMocks();
  data.currentVersionsOfModel.mockResolvedValue([]);
  data.entriesWithModelKeys.mockResolvedValue([]);
  data.listEntryVersions.mockResolvedValue([]);
  data.getEntry.mockResolvedValue(null);
  mockGetModel.mockResolvedValue(model as never);
  mockGetVersion.mockResolvedValue(version as never);
});

/** The reads behind a save: the entry, then its versions (model and schema come from the defaults). */
function editing(current: typeof entry = entry) {
  data.getEntry.mockResolvedValue(current as never);
  data.listEntryVersions.mockResolvedValue(existingVersions as never);
}

describe("saveDraft", () => {
  it("rejects edits to an archived entry", async () => {
    data.getEntry.mockResolvedValue(archivedEntry as never);

    const result = await saveDraft({ workspaceId: "ws-1", entryId: "entry-1", data: { title: "New" }, actorAdminUserId: "admin-1" });
    expect(result.ok).toBe(false);
    if (!result.ok) { expect(result.status).toBe(409); expect(result.error).toMatch(/archived/i); }
    expect(data.callEntryFunction).not.toHaveBeenCalled();
  });

  it("rejects a stale save when expectedVersionNumber does not match the latest version", async () => {
    editing();

    const result = await saveDraft({ workspaceId: "ws-1", entryId: "entry-1", data: { title: "New" }, actorAdminUserId: "admin-1", expectedVersionNumber: 1 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(409);
      expect("conflict" in result).toBe(true);
    }
    expect(data.callEntryFunction).not.toHaveBeenCalled();
  });

  it("rejects invalid entry data before writing", async () => {
    editing();

    const result = await saveDraft({ workspaceId: "ws-1", entryId: "entry-1", data: { title: "" }, actorAdminUserId: "admin-1" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(400);
    expect(data.callEntryFunction).not.toHaveBeenCalled(); // no version insert attempted
  });

  it("rejects a relation field that references the entry itself", async () => {
    editing();

    const result = await saveDraft({ workspaceId: "ws-1", entryId: "entry-1", data: { title: "New", related: "entry-1" }, actorAdminUserId: "admin-1" });
    expect(result.ok).toBe(false);
    if (!result.ok) { expect(result.status).toBe(400); expect(result.error).toMatch(/itself/i); }
    expect(data.callEntryFunction).not.toHaveBeenCalled();
  });

  it("rejects a value that duplicates another entry's unique field", async () => {
    editing();
    data.currentVersionsOfModel.mockResolvedValue([{ entry_id: "other-entry", data_jsonb: { email: "dup@example.com" } }]);

    const result = await saveDraft({ workspaceId: "ws-1", entryId: "entry-1", data: { title: "New", email: "dup@example.com" }, actorAdminUserId: "admin-1" });
    expect(result.ok).toBe(false);
    if (!result.ok) { expect(result.status).toBe(409); expect(result.error).toMatch(/unique/i); }
    expect(data.callEntryFunction).not.toHaveBeenCalled();
  });
});

describe("createEntry", () => {
  it("rejects creation against a model that is not active", async () => {
    mockGetModel.mockResolvedValue({ ...model, status: "draft" } as never);

    const result = await createEntry({ workspaceId: "ws-1", modelId: "model-1", data: { title: "New" }, actorAdminUserId: "admin-1" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(404);
  });

  it("rejects a relation targeting an entry outside the workspace", async () => {
    // The target lookup is scoped to the workspace, so another workspace's entry comes back empty.
    data.entriesWithModelKeys.mockResolvedValue([]);

    const result = await createEntry({ workspaceId: "ws-1", modelId: "model-1", data: { title: "New", related: "entry-from-other-workspace" }, actorAdminUserId: "admin-1" });
    expect(result.ok).toBe(false);
    if (!result.ok) { expect(result.status).toBe(400); expect(result.error).toMatch(/do not exist in this workspace/i); }
    expect(data.callEntryFunction).not.toHaveBeenCalled(); // no orphan entry insert after rejected relation
  });
});

describe("importEntries", () => {
  it("flags a duplicate unique value within the same import batch without writing either row", async () => {
    const result = await importEntries({
      workspaceId: "ws-1",
      modelId: "model-1",
      dryRun: true,
      actorAdminUserId: "admin-1",
      rows: [{ title: "A", email: "dup@example.com" }, { title: "B", email: "dup@example.com" }],
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.succeeded).toBe(1);
      expect(result.data.failed).toBe(1);
      expect(result.data.results[1].errors.join(" ")).toMatch(/duplicates another row/i);
    }
    expect(data.callEntryFunction).not.toHaveBeenCalled();
  });

  it("rejects invalid rows and reports their index without writing", async () => {
    const result = await importEntries({ workspaceId: "ws-1", modelId: "model-1", dryRun: true, actorAdminUserId: "admin-1", rows: [{ title: "" }] });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.results[0]).toMatchObject({ index: 0, ok: false });
      expect(result.data.results[0].entryId).toBeUndefined();
    }
    expect(data.callEntryFunction).not.toHaveBeenCalled();
  });
});

describe("archiveEntry / unarchiveEntry", () => {
  it("calls cms_archive_content_entry with correct params and returns archived entry", async () => {
    const inReview = { ...entry, status: "in_review" as const };
    data.getEntry.mockResolvedValue(inReview as never);
    data.callEntryFunction.mockResolvedValue({ ok: true, data: { ...inReview, status: "archived", status_before_archive: "in_review" } });

    const result = await archiveEntry({ workspaceId: "ws-1", entryId: "entry-1", actorAdminUserId: "admin-1" });
    expect(result.ok).toBe(true);
    expect(data.callEntryFunction).toHaveBeenCalledWith("cms_archive_content_entry", {
      p_workspace_id: "ws-1",
      p_actor_id: "admin-1",
      p_entry_id: "entry-1",
    });
    if (result.ok) {
      expect(result.data.status).toBe("archived");
    }
  });

  it("calls cms_unarchive_content_entry and restores pre-archive status", async () => {
    const archivedFromApproved = { ...entry, status: "archived" as const, status_before_archive: "approved" as const };
    data.getEntry.mockResolvedValue(archivedFromApproved as never);
    data.callEntryFunction.mockResolvedValue({ ok: true, data: { ...archivedFromApproved, status: "approved", status_before_archive: null } });

    const result = await unarchiveEntry({ workspaceId: "ws-1", entryId: "entry-1", actorAdminUserId: "admin-1" });
    expect(result.ok).toBe(true);
    expect(data.callEntryFunction).toHaveBeenCalledWith("cms_unarchive_content_entry", {
      p_workspace_id: "ws-1",
      p_actor_id: "admin-1",
      p_entry_id: "entry-1",
    });
    if (result.ok) {
      expect(result.data.status).toBe("approved");
    }
  });

  it("returns error if archive or unarchive RPC fails", async () => {
    data.getEntry.mockResolvedValue({ ...entry, status: "in_review" as const } as never);
    data.callEntryFunction.mockResolvedValue({ ok: false, code: null, message: "Database transaction failed" });

    const result = await archiveEntry({ workspaceId: "ws-1", entryId: "entry-1", actorAdminUserId: "admin-1" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("Database transaction failed");
    }
  });
});
