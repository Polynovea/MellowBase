// Phase 3, wave 3: moving existing content into the model tables (migration 0076).
//
// - A realistic fixture install (two models, every column type, 2,500 posts in drafts, published
//   versions and both, three locales, missing keys, nulls, stale keys, quotes and Unicode) is migrated
//   the production way: the table is requested as the app role and created by the migration worker,
//   then backfilled in 1,000-entry batches and verified. Every count and every field checksum match.
// - The checksum catches a changed value, a missing row and a value that does not convert.
// - Reads switch to the table and are rolled back by switching them back (rehearsed on one model).
// - The sync writes each entry to its own model's table, whatever the batch mixes.
// - Workspace isolation through the switched read path; the catalog rules of the new functions.
// - Saves keep the table in step (one sync per statement), timed for 1,000 entries.
// - Random sequences of model changes, each applied and reverted, with the table matching after each.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import pg from "pg";
import { describeWithDatabase, type BackendFixtures } from "@/lib/db/testing/database";
import { getDb } from "@/lib/db/index";
import { uniqueKey } from "@/lib/schema/engine/testing";
import { applyChange, createModel, getModel } from "@/lib/schema/modelService";
import { requestSchemaChange } from "@/lib/schema/runner/request";
import { TEST_LIMITS } from "@/lib/schema/engine/testing";
import { backfillModel, modelsNeedingResync, moveRun, readSourceOf, resyncChangedModels, setReadSource, syncEntries, verifyModel } from "@/lib/content/contentMove";
import { bringModelTableUp, closeTableMoveSession, runWorker } from "@/lib/content/testing/tableMove";
import { createEntry } from "@/lib/content/entryService";
import { searchContent } from "@/lib/content/searchService";
import { derivedName } from "@/lib/schema/engine/names";
import { currentVersionsOfModel, listEntries } from "@/lib/content/entryData";
import { readTableRows, tableSource } from "@/lib/content/tableStore";
import { getPublishedContent, listPublishedContent } from "@/lib/developer/publishedContentService";
import type { FieldDefinition } from "@/lib/schema/fields/types";

vi.setConfig({ testTimeout: 300_000, hookTimeout: 120_000 });

const report = (label: string, value: unknown) => console.log(`[content-move] ${label} ${JSON.stringify(value)}`);

type Field = Partial<FieldDefinition> & { key: string; type: FieldDefinition["type"] };
const field = (f: Field): FieldDefinition => ({ label: f.key, required: false, localized: false, unique: false, ...f } as FieldDefinition);

const pad = (n: number) => String(n).padStart(2, "0");
const LOCALES = ["en", "hi", "en-IN"];

/** One post's data as an editor would have saved it, with the irregularities real installs have. */
function postData(i: number, variant: "draft" | "published", people: string[], postIds: string[]): Record<string, unknown> {
  const data: Record<string, unknown> = {
    title: `Post ${i}${variant === "draft" ? " (draft)" : ""}${i % 7 === 0 ? " — 日本語 ✓ “quoted”" : ""}`,
    slug: `post-${i}`,
    notes: `# Notes ${i}\n\n- it's a list item with 'quotes' and a back\\slash`,
    url: `https://example.test/p/${i}`,
    kind: ["news", "guide", "faq"][i % 3],
    tags: i % 6 === 0 ? [] : ["a", "b", "c"].slice(0, 1 + (i % 3)),
    views: i % 13 === 0 ? String(i * 3) : i * 3,
    featured: i % 2 === 0,
    launch: `2026-${pad(1 + (i % 12))}-${pad(1 + (i % 28))}`,
    published_at: i % 8 === 0 ? "2026-03-01T10:00:00+05:30" : `2026-01-${pad(1 + (i % 28))}T0${i % 10}:15:00.000Z`,
    meta: { score: i, nested: { ok: i % 2 === 0 }, list: [1, "two", null] },
    content: { type: "doc", content: [{ type: "paragraph", text: `Paragraph ${i}` }] },
    related: i > 1 ? [postIds[i - 2]] : [],
  };
  if (i % 5 !== 0) data.body = i % 11 === 0 ? null : `Body of post ${i}. It has "double quotes" and Kubernetes ${i % 4 === 0 ? "pods" : "nodes"}.`;
  if (i % 4 !== 0) data.email = `author${i}@example.test`;
  if (i % 9 !== 0) data.price = i % 13 === 0 ? `${i}.50` : Number((i * 1.25).toFixed(2));
  if (i % 10 !== 3) data.author = people[i % people.length];
  if (i % 17 === 0) data.stale_field = "left over from a deleted field";
  return data;
}

const POST_FIELDS = (personKey: string, postKey: string): FieldDefinition[] => [
  field({ key: "title", type: "text", required: true }),
  field({ key: "body", type: "long_text" }),
  field({ key: "notes", type: "markdown" }),
  field({ key: "slug", type: "slug", unique: true }),
  field({ key: "email", type: "email" }),
  field({ key: "url", type: "url" }),
  field({ key: "kind", type: "select", validation: { options: ["news", "guide", "faq"] } }),
  field({ key: "tags", type: "multi_select", validation: { options: ["a", "b", "c"] } }),
  field({ key: "price", type: "number" }),
  field({ key: "views", type: "integer", index: true }),
  field({ key: "featured", type: "boolean" }),
  field({ key: "launch", type: "date" }),
  field({ key: "published_at", type: "datetime" }),
  field({ key: "meta", type: "json" }),
  field({ key: "content", type: "rich_text" }),
  field({ key: "author", type: "relation", relation: { targetModelApiKey: personKey, cardinality: "many_to_one", onDelete: "block" } }),
  field({ key: "related", type: "relation", relation: { targetModelApiKey: postKey, cardinality: "many_to_many", onDelete: "remove_reference" } }),
];

interface Install {
  workspaceId: string;
  adminUserId: string;
  personModelId: string;
  postModelId: string;
  postKey: string;
  people: string[];
  posts: string[];
  expected: { draft: number; published: number };
}

/** Inserts entries and their versions directly, the way an install looks before the move. */
async function insertEntries(backend: BackendFixtures, workspaceId: string, modelId: string, rows: Array<{ id: string; status: string; draft?: { data: unknown; locale: string }; published?: { data: unknown; locale: string } }>) {
  for (let start = 0; start < rows.length; start += 500) {
    const chunk = rows.slice(start, start + 500);
    await backend.query(
      "insert into content_entries (id, workspace_id, content_model_id, status) select id, $1, $2, status from unnest($3::uuid[], $4::text[]) as x(id, status)",
      [workspaceId, modelId, chunk.map((r) => r.id), chunk.map((r) => r.status)],
    );
    const versions: Array<[string, string, number, string, string, string]> = [];
    const pointers: Array<[string, string | null, string | null]> = [];
    for (const row of chunk) {
      let n = 0;
      let draftId: string | null = null;
      let publishedId: string | null = null;
      if (row.published) { publishedId = randomUUID(); versions.push([publishedId, row.id, ++n, JSON.stringify(row.published.data), row.published.locale, "published"]); }
      if (row.draft) { draftId = randomUUID(); versions.push([draftId, row.id, ++n, JSON.stringify(row.draft.data), row.draft.locale, "draft"]); }
      pointers.push([row.id, draftId, publishedId]);
    }
    await backend.query(
      `insert into content_entry_versions (id, entry_id, model_schema_version, version_number, data_jsonb, locale, state)
       select id, entry_id, 1, n, data::jsonb, locale, state from unnest($1::uuid[], $2::uuid[], $3::int[], $4::text[], $5::text[], $6::text[]) as x(id, entry_id, n, data, locale, state)`,
      [versions.map((v) => v[0]), versions.map((v) => v[1]), versions.map((v) => v[2]), versions.map((v) => v[3]), versions.map((v) => v[4]), versions.map((v) => v[5])],
    );
    await backend.query(
      `update content_entries e set current_draft_version_id = x.d, published_version_id = x.p
         from unnest($1::uuid[], $2::uuid[], $3::uuid[]) as x(id, d, p) where e.id = x.id`,
      [pointers.map((p) => p[0]), pointers.map((p) => p[1]), pointers.map((p) => p[2])],
    );
  }
}

async function fixtureInstall(backend: BackendFixtures, size: number): Promise<Install> {
  const { workspaceId, adminUserId } = await backend.createWorkspace();
  await backend.query("insert into workspace_members (workspace_id, admin_user_id, status) values ($1, $2, 'active')", [workspaceId, adminUserId]);
  const personKey = uniqueKey("person");
  const postKey = uniqueKey("post");
  const person = await createModel({ workspaceId, createdBy: adminUserId, proposedSchema: { name: "Person", apiKey: personKey, fields: [field({ key: "name", type: "text", required: true }), field({ key: "bio", type: "long_text" })] } });
  const post = await createModel({ workspaceId, createdBy: adminUserId, proposedSchema: { name: "Post", apiKey: postKey, fields: POST_FIELDS(personKey, postKey) } });
  if (!person.ok || !post.ok) throw new Error("fixture models failed");

  const people = Array.from({ length: 40 }, () => randomUUID());
  await insertEntries(backend, workspaceId, person.data.model.id, people.map((id, i) => ({
    id, status: "published", published: { data: { name: `Person ${i}`, bio: i % 3 ? `Bio ${i}` : undefined }, locale: "en" },
  })));

  const posts = Array.from({ length: size }, () => randomUUID());
  const expected = { draft: 0, published: 0 };
  await insertEntries(backend, workspaceId, post.data.model.id, posts.map((id, index) => {
    const i = index + 1;
    const kind = i % 3; // 0: published only, 1: draft only, 2: published with a newer draft
    const locale = LOCALES[i % LOCALES.length];
    const row: Parameters<typeof insertEntries>[3][number] = { id, status: i % 10 === 0 ? "archived" : kind === 1 ? "draft" : "published" };
    if (kind !== 1) { row.published = { data: postData(i, "published", people, posts), locale }; expected.published += 1; }
    if (kind !== 0) { row.draft = { data: postData(i, "draft", people, posts), locale: i % 29 === 0 ? "hi" : locale }; expected.draft += 1; }
    return row;
  }));
  return { workspaceId, adminUserId, personModelId: person.data.model.id, postModelId: post.data.model.id, postKey, people, posts, expected };
}

const tableOf = async (backend: BackendFixtures, modelId: string) =>
  (await backend.query<{ table_name: string }>("select table_name from content_model_tables where content_model_id = $1", [modelId]))[0]?.table_name;

const errorOf = async (promise: Promise<unknown>) => promise.then(() => null, (error: { code?: string; message?: string }) => ({ code: error.code, message: error.message }));

describeWithDatabase("moving existing content into the model tables", (backend) => {
  let owner: pg.Client;
  let app: pg.Client;
  let install: Install;
  beforeAll(async () => {
    const connect = async (name: string) => {
      const client = new pg.Client({ connectionString: process.env[name], ssl: false });
      await client.connect();
      return client;
    };
    [owner, app] = await Promise.all([connect("POLYNOVEA_TEST_POSTGRES_OWNER_URL"), connect("POLYNOVEA_TEST_POSTGRES_URL")]);
    install = await fixtureInstall(backend, 2_500);
  });
  afterAll(async () => {
    await Promise.all([owner?.end(), app?.end()]);
    await closeTableMoveSession();
  });

  it("migrates the fixture install: tables by the worker, 1,000-entry batches, every count and checksum matching", async () => {
    const { workspaceId, adminUserId } = install;
    const person = await bringModelTableUp({ workspaceId, modelId: install.personModelId, actor: adminUserId });
    expect(person.outcomes).toEqual(["succeeded"]);
    expect(person.verify).toMatchObject({ matched: true, mismatches: [] });

    const post = await bringModelTableUp({ workspaceId, modelId: install.postModelId, actor: adminUserId });
    expect(post.outcomes).toEqual(["succeeded"]);
    expect(post.backfill).toMatchObject({ batches: 3, entries: 2_500, synced: 2_500, skippedNoTable: 0, missing: 0, failed: [] });
    expect(post.verify).toMatchObject({ matched: true, mismatches: [] });

    const run = (await moveRun(getDb(), post.verify.runId))!;
    expect(run.counts.snapshot).toMatchObject(install.expected);
    expect(run.counts.table).toMatchObject(install.expected);
    expect(run.counts.snapshot.rows).toBe(run.counts.table.rows);
    expect(run.counts.foreign_rows).toBe(0);
    // Every column except the to-many relation, each variant, equal on both sides and not trivially empty.
    expect(Object.values(run.fields).map((f) => f.field).sort()).toEqual(POST_FIELDS("p", "q").map((f) => f.key).filter((k) => k !== "related").sort());
    for (const [column, f] of Object.entries(run.fields)) {
      for (const variant of ["draft", "published"] as const) {
        expect({ column, variant, side: f[variant].table }).toEqual({ column, variant, side: f[variant].snapshot });
      }
      expect((f.draft.snapshot?.[0] ?? 0) + (f.published.snapshot?.[0] ?? 0)).toBeGreaterThan(0);
    }
    report("fixture_counts", { posts: install.posts.length, people: install.people.length, expected: install.expected, backfill: post.backfill, personBackfill: person.backfill });
    report("fixture_run", { runId: run.id, counts: run.counts, fields: run.fields });

    // The search indexes the engine built for the prose columns.
    const table = await tableOf(backend, install.postModelId);
    const indexes = await backend.query<{ indexdef: string }>("select indexdef from pg_indexes where schemaname = 'content' and tablename = $1 and indexdef like '%gin_trgm_ops%' order by 1", [table]);
    expect(indexes.map((i) => i.indexdef.match(/\(([a-z_]+) gin_trgm_ops\)/)?.[1]).sort()).toEqual(["body", "notes", "title"]);
  });

  it("the checksum catches a changed value, a missing row and a value that does not convert", async () => {
    const { workspaceId, postModelId, posts } = install;
    const table = await tableOf(backend, postModelId);
    await backend.query(`update content.${table} set price = price + 1 where _entry_id = $1 and price is not null`, [posts[0]]);
    const changed = await verifyModel(getDb(), { workspaceId, modelId: postModelId });
    expect(changed.matched).toBe(false);
    // posts[0] is post 1: a draft only.
    expect(changed.mismatches).toEqual([{ kind: "field_checksum", column: "price", variant: "draft" }]);

    await backend.query(`delete from content.${table} where _entry_id = $1`, [posts[1]]);
    const missing = await verifyModel(getDb(), { workspaceId, modelId: postModelId });
    expect(missing.mismatches.map((m) => m.kind)).toEqual(expect.arrayContaining(["row_count", "row_checksum"]));

    // Re-syncing those entries restores the match.
    expect(await syncEntries(getDb(), [posts[0], posts[1]])).toMatchObject({ requested: 2, synced: 2, failed: [] });
    expect(await verifyModel(getDb(), { workspaceId, modelId: postModelId })).toMatchObject({ matched: true });
  });

  it("rehearses a rollback: reads switch to the table, back to the snapshots, and to the table again", async () => {
    const { workspaceId, postModelId, posts } = install;
    expect(await readSourceOf(getDb(), postModelId)).toBe("snapshot");
    await setReadSource(getDb(), { workspaceId, modelId: postModelId, source: "table", actor: install.adminUserId });
    expect(await readSourceOf(getDb(), postModelId)).toBe("table");

    // Mark one table row so the read source is visible.
    const table = await tableOf(backend, postModelId);
    const target = posts[2]; // i = 3: published only
    await backend.query(`update content.${table} set title = 'From the table' where _entry_id = $1`, [target]);
    const titleOf = async () => (await currentVersionsOfModel(workspaceId, postModelId))?.find((e) => e.entry_id === target)?.data_jsonb.title;
    const published = async () => (await getPublishedContent({ workspaceId, modelApiKey: install.postKey, entryId: target })).record?.data.title;
    expect(await titleOf()).toBe("From the table");
    expect(await published()).toBe("From the table");

    // Reads from the table return field keys, typed values in one form, and no stale keys.
    const source = (await tableSource(workspaceId, postModelId))!;
    const rows = await readTableRows(workspaceId, source, { entryIds: [posts[7]], variant: "published" });
    expect(rows).toHaveLength(1);
    expect(rows[0].data).toMatchObject({ slug: "post-8", views: 24, featured: true, published_at: "2026-03-01T04:30:00.000Z", related: [posts[6]] });
    const [stale] = await readTableRows(workspaceId, source, { entryIds: [posts[16]], variant: "published" });
    expect(stale.data).toMatchObject({ slug: "post-17" });
    expect(stale.data).not.toHaveProperty("stale_field");

    await setReadSource(getDb(), { workspaceId, modelId: postModelId, source: "snapshot", actor: install.adminUserId });
    expect(await titleOf()).toBe("Post 3");
    expect(await published()).toBe("Post 3");
    await setReadSource(getDb(), { workspaceId, modelId: postModelId, source: "table", actor: install.adminUserId });
    expect(await titleOf()).toBe("From the table");
    expect(await published()).toBe("From the table");

    await syncEntries(getDb(), [target]);
    expect(await titleOf()).toBe("Post 3");
    await setReadSource(getDb(), { workspaceId, modelId: postModelId, source: "snapshot", actor: install.adminUserId });
  });

  it("switching to the table is refused without a matching run on the current shape, while a change is queued, or after a failed sync", async () => {
    const { workspaceId, adminUserId } = await backend.createWorkspace();
    await backend.query("insert into workspace_members (workspace_id, admin_user_id, status) values ($1, $2, 'active')", [workspaceId, adminUserId]);
    const apiKey = uniqueKey("note");
    const created = await createModel({ workspaceId, createdBy: adminUserId, proposedSchema: { name: "Note", apiKey, fields: [field({ key: "title", type: "text" }), field({ key: "count", type: "integer" })] } });
    if (!created.ok) throw new Error(created.error);
    const modelId = created.data.model.id;
    const db = getDb();
    const refusal = (source: "table" | "snapshot" = "table") => errorOf(setReadSource(db, { workspaceId, modelId, source }));
    expect(await refusal()).toEqual({ code: "P0002", message: "content_model_has_no_table" });

    // Table, but no run yet.
    const up = await bringModelTableUp({ workspaceId, modelId, actor: adminUserId });
    await backend.query("delete from content_model_move_runs where content_model_id = $1", [modelId]);
    expect(await refusal()).toEqual({ code: "55000", message: "content_read_switch_no_matching_run" });
    expect(up.verify.matched).toBe(true);
    await verifyModel(db, { workspaceId, modelId });

    // A change queued for the worker.
    const current = (await getModel(workspaceId, modelId))!;
    const changed = await applyChange({ model: current, proposedSchema: { name: "Note", apiKey, fields: [field({ key: "title", type: "text" }), field({ key: "count", type: "integer" }), field({ key: "extra", type: "text" })] }, acknowledgeUnsafe: true, actorAdminUserId: adminUserId });
    if (!changed.ok || !changed.data.version) throw new Error("version 2 not created");
    await requestSchemaChange(db, { contentModelId: modelId, targetVersionId: changed.data.version.id, requestedBy: adminUserId, limits: TEST_LIMITS });
    expect(await refusal()).toEqual({ code: "55000", message: "content_read_switch_schema_change_pending" });

    // The change ran, and the worker re-synced and re-verified the model on its new shape by itself.
    const [beforeChange] = await backend.query<{ id: string }>("select last_run_id as id from content_model_storage where content_model_id = $1", [modelId]);
    expect(await runWorker(modelId)).toEqual(["succeeded"]);
    const [afterChange] = await backend.query<{ id: string; matched: boolean }>(
      "select r.id, r.matched from content_model_storage s join content_model_move_runs r on r.id = s.last_run_id where s.content_model_id = $1", [modelId]);
    expect(afterChange.id).not.toBe(beforeChange.id);
    expect(afterChange.matched).toBe(true);
    // A run on a shape that is no longer current is refused (the run from before the change).
    await backend.query("update content_model_storage set last_run_id = $1 where content_model_id = $2", [beforeChange.id, modelId]);
    await backend.query("delete from content_model_move_runs where id = $1", [afterChange.id]);
    expect(await refusal()).toEqual({ code: "55000", message: "content_read_switch_stale_shape" });
    await backfillModel(db, { workspaceId, modelId });

    // A save that could not reach the table (the model reads snapshots: the save itself succeeds).
    await verifyModel(db, { workspaceId, modelId });
    const [entry] = await backend.query<{ id: string }>("insert into content_entries (workspace_id, content_model_id) values ($1, $2) returning id", [workspaceId, modelId]);
    const [version] = await backend.query<{ id: string }>("insert into content_entry_versions (entry_id, model_schema_version, version_number, data_jsonb) values ($1, 1, 1, $2) returning id", [entry.id, JSON.stringify({ title: "x", count: "not a number" })]);
    await backend.query("update content_entries set current_draft_version_id = $1 where id = $2", [version.id, entry.id]);
    const [storage] = await backend.query<{ out_of_sync_code: string; read_source: string }>("select out_of_sync_code, read_source from content_model_storage where content_model_id = $1", [modelId]);
    expect(storage).toEqual({ out_of_sync_code: "sqlstate_22p02", read_source: "snapshot" });
    expect(await refusal()).toEqual({ code: "55000", message: "content_read_switch_out_of_sync" });
    const bad = await verifyModel(db, { workspaceId, modelId });
    expect(bad.matched).toBe(false);
    expect(bad.mismatches).toEqual(expect.arrayContaining([
      { kind: "snapshot_fields_failed" }, { kind: "snapshot_value_not_convertible", column: "count" }, { kind: "row_count", variant: "draft" }]));
    // The field checksums could not be computed on the snapshot side: recorded as such, never as equal.
    const badRun = (await moveRun(db, bad.runId))!;
    expect(Object.values(badRun.fields).every((f) => f.draft.snapshot === null && f.published.snapshot === null)).toBe(true);
    // Even with every row present, a run whose snapshot checksums failed does not match: the bad
    // entry's row is written by hand (as if a save had slipped past), so counts and rows agree.
    const [badTable] = await backend.query<{ table_name: string }>("select table_name from content_model_tables where content_model_id = $1", [modelId]);
    await owner.query(`insert into content.${badTable.table_name} (_entry_id, _variant, _locale, title) values ($1, 'draft', 'en', 'x')`, [entry.id]);
    const countsOnly = await verifyModel(db, { workspaceId, modelId });
    expect(countsOnly.matched).toBe(false);
    expect(countsOnly.mismatches.map((m) => m.kind).sort()).toEqual(["snapshot_fields_failed", "snapshot_value_not_convertible"]);

    // Fixed content, a new matching run: the switch goes through. Then a bad save fails outright.
    await backend.query("update content_entry_versions set data_jsonb = $1 where id = $2", [JSON.stringify({ title: "x", count: 3 }), version.id]);
    expect(await syncEntries(db, [entry.id])).toMatchObject({ synced: 1, failed: [] });
    expect(await verifyModel(db, { workspaceId, modelId })).toMatchObject({ matched: true });
    expect(await refusal()).toBeNull();
    const [v2] = await backend.query<{ id: string }>("insert into content_entry_versions (entry_id, model_schema_version, version_number, data_jsonb) values ($1, 1, 2, $2) returning id", [entry.id, JSON.stringify({ count: "nope" })]);
    expect(await errorOf(backend.query("update content_entries set current_draft_version_id = $1 where id = $2", [v2.id, entry.id]))).toEqual({ code: "22P02", message: "content_table_write_failed" });
    expect((await currentVersionsOfModel(workspaceId, modelId))?.map((row) => row.data_jsonb)).toEqual([{ title: "x", count: 3 }]);
    // Rolling back is always allowed.
    expect(await refusal("snapshot")).toBeNull();
  });

  it("a save that fails while a verification is reading can never switch reads to stale rows (two connections)", async () => {
    const { workspaceId, adminUserId } = await backend.createWorkspace();
    await backend.query("insert into workspace_members (workspace_id, admin_user_id, status) values ($1, $2, 'active')", [workspaceId, adminUserId]);
    const created = await createModel({ workspaceId, createdBy: adminUserId, proposedSchema: { name: "Race", apiKey: uniqueKey("race"), fields: [field({ key: "title", type: "text" }), field({ key: "count", type: "integer" })] } });
    if (!created.ok) throw new Error(created.error);
    const modelId = created.data.model.id;
    const entryId = randomUUID();
    await insertEntries(backend, workspaceId, modelId, [{ id: entryId, status: "published", published: { data: { title: "ok", count: 1 }, locale: "en" } }]);
    expect((await bringModelTableUp({ workspaceId, modelId, actor: adminUserId })).verify.matched).toBe(true);
    const db = getDb();

    // Connection A: a save whose new version cannot be written to the table (the model reads its
    // snapshots, so the save goes through). Not committed yet: the failure is recorded in its transaction.
    await app.query("begin");
    const { rows: [bad] } = await app.query<{ id: string }>(
      "insert into content_entry_versions (entry_id, model_schema_version, version_number, data_jsonb) values ($1, 1, 2, $2) returning id",
      [entryId, JSON.stringify({ title: "new", count: "not a number" })]);
    await app.query("update content_entries set published_version_id = $1 where id = $2", [bad.id, entryId]);

    // Connection B: a verification starts meanwhile and reads the committed content, which still matches.
    const verifying = verifyModel(db, { workspaceId, modelId });
    // It reads without waiting; only recording its run waits for A's row in content_model_storage.
    const deadline = Date.now() + 15_000;
    for (;;) {
      const [waiting] = await owner.query<{ n: number }>(
        "select count(*)::int as n from pg_stat_activity where wait_event_type = 'Lock' and query like '%polynovea_content_verify_model%' and pid <> pg_backend_pid()").then((r) => r.rows);
      if (waiting.n > 0 || Date.now() > deadline) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await app.query("commit");
    const run = await verifying;
    expect(run.matched).toBe(true);

    // The failed save committed after the run began reading: that run can never switch reads...
    expect(await errorOf(setReadSource(db, { workspaceId, modelId, source: "table" }))).toEqual({ code: "55000", message: "content_read_switch_out_of_sync" });
    // ...and even with the intent forced to 'table', reads do not use the table on that run.
    await owner.query("update content_model_storage set read_source = 'table' where content_model_id = $1", [modelId]);
    expect(await tableSource(workspaceId, modelId)).toBeNull();
    await owner.query("update content_model_storage set read_source = 'snapshot' where content_model_id = $1", [modelId]);
    const [counts] = await backend.query<{ storage: string; run: string }>(
      "select s.sync_failures::text as storage, r.sync_failures::text as run from content_model_storage s join content_model_move_runs r on r.id = $2 where s.content_model_id = $1", [modelId, run.runId]);
    expect(counts).toEqual({ storage: "1", run: "0" });
  });

  it("a 1,000-entry batch with one entry that cannot be written syncs the other 999 and stays fast", async () => {
    const { workspaceId, adminUserId } = await backend.createWorkspace();
    await backend.query("insert into workspace_members (workspace_id, admin_user_id, status) values ($1, $2, 'active')", [workspaceId, adminUserId]);
    const created = await createModel({ workspaceId, createdBy: adminUserId, proposedSchema: { name: "Bulk", apiKey: uniqueKey("bulk"), fields: [field({ key: "title", type: "text" }), field({ key: "count", type: "integer" })] } });
    if (!created.ok) throw new Error(created.error);
    const modelId = created.data.model.id;
    expect((await bringModelTableUp({ workspaceId, modelId, actor: adminUserId })).verify.matched).toBe(true);
    const ids = Array.from({ length: 1_000 }, () => randomUUID()).sort();
    const badIndex = 613;
    await insertEntries(backend, workspaceId, modelId, ids.map((id, n) => ({
      id, status: "published", published: { data: { title: `T${n}`, count: n === badIndex ? "not a number" : n }, locale: "en" },
    })));
    const db = getDb();
    const table = await tableOf(backend, modelId);

    // The whole batch again, with the bad entry, against the same batch without it.
    const good = ids.filter((_, n) => n !== badIndex);
    let started = performance.now();
    const clean = await db.transaction().execute((trx) => syncEntries(trx, good));
    const cleanMs = performance.now() - started;
    started = performance.now();
    const mixed = await db.transaction().execute((trx) => syncEntries(trx, ids));
    const mixedMs = performance.now() - started;
    expect(clean).toMatchObject({ requested: 999, synced: 999, failed: [] });
    expect(mixed).toMatchObject({ requested: 1_000, synced: 999, skipped_no_table: 0, missing: 0, failed: [ids[badIndex]] });
    const [rows] = await backend.query<{ n: number; bad: number }>(
      `select count(*)::int as n, count(*) filter (where _entry_id = $1)::int as bad from content.${table}`, [ids[badIndex]]);
    expect(rows).toEqual({ n: 999, bad: 0 });
    // Halving finds the entry in about 20 tries; one try per entry would be 1,000.
    report("bad_entry_batch", { entries: 1_000, cleanMs: Math.round(cleanMs), mixedMs: Math.round(mixedMs) });
    expect(mixedMs).toBeLessThan(cleanMs * 6 + 500);

    // Two bad entries far apart, and the model's failure count goes up once per batch.
    const [before] = await backend.query<{ n: string }>("select sync_failures::text as n from content_model_storage where content_model_id = $1", [modelId]);
    await backend.query("update content_entry_versions set data_jsonb = jsonb_set(data_jsonb, '{count}', '\"x\"') where entry_id = $1", [ids[3]]);
    const two = await db.transaction().execute((trx) => syncEntries(trx, ids));
    expect(two).toMatchObject({ synced: 998, failed: [ids[3], ids[badIndex]] });
    const [after] = await backend.query<{ n: string }>("select sync_failures::text as n from content_model_storage where content_model_id = $1", [modelId]);
    expect(Number(after.n)).toBe(Number(before.n) + 1);
  });

  it("a timestamp without an offset is UTC to the sync and the verification, whatever the session's time zone", async () => {
    const { workspaceId, adminUserId } = await backend.createWorkspace();
    await backend.query("insert into workspace_members (workspace_id, admin_user_id, status) values ($1, $2, 'active')", [workspaceId, adminUserId]);
    const created = await createModel({ workspaceId, createdBy: adminUserId, proposedSchema: { name: "Clock", apiKey: uniqueKey("clock"), fields: [field({ key: "title", type: "text" }), field({ key: "happens_at", type: "datetime" })] } });
    if (!created.ok) throw new Error(created.error);
    const modelId = created.data.model.id;
    expect((await bringModelTableUp({ workspaceId, modelId, actor: adminUserId })).verify.matched).toBe(true);
    const entryId = randomUUID();
    const versionId = randomUUID();
    // Saved from a session in India (+05:30).
    await app.query("begin");
    await app.query("set local timezone = 'Asia/Kolkata'");
    await app.query("insert into content_entries (id, workspace_id, content_model_id, status) values ($1, $2, $3, 'published')", [entryId, workspaceId, modelId]);
    await app.query(
      "insert into content_entry_versions (id, entry_id, model_schema_version, version_number, data_jsonb, locale, state) values ($1, $2, 1, 1, $3, 'en', 'published')",
      [versionId, entryId, JSON.stringify({ title: "Launch", happens_at: "2026-03-01 10:00:00" })]);
    await app.query("update content_entries set published_version_id = $1 where id = $2", [versionId, entryId]);
    await app.query("commit");
    const table = await tableOf(backend, modelId);
    const { rows: [column] } = await owner.query<{ name: string }>(
      "select c.key as name from content_model_tables t, jsonb_each(t.applied_shape -> 'columns') c where t.content_model_id = $1 and c.value ->> 'field' = 'happens_at'", [modelId]);
    const { rows: [row] } = await owner.query<{ epoch: string }>(`select extract(epoch from "${column.name}")::bigint::text as epoch from content.${table} where _entry_id = $1`, [entryId]);
    expect(Number(row.epoch)).toBe(Date.UTC(2026, 2, 1, 10) / 1000);
    // Verified from a session in New York (-05:00): the same instant on both sides.
    await app.query("set timezone = 'America/New_York'");
    const { rows: [verified] } = await app.query("select public.polynovea_content_verify_model($1, $2) as result", [workspaceId, modelId]);
    await app.query("reset timezone");
    expect(verified.result).toMatchObject({ matched: true, mismatches: [] });
  });

  it("each entry is written to its own model's table, whatever the batch mixes; deleted entries lose their rows", async () => {
    const db = getDb();
    const other = await backend.createWorkspace();
    const otherKey = uniqueKey("thing");
    const otherModel = await createModel({ workspaceId: other.workspaceId, createdBy: other.adminUserId, proposedSchema: { name: "Thing", apiKey: otherKey, fields: [field({ key: "title", type: "text" })] } });
    const noTable = await createModel({ workspaceId: other.workspaceId, createdBy: other.adminUserId, proposedSchema: { name: "Loose", apiKey: uniqueKey("loose"), fields: [field({ key: "title", type: "text" })] } });
    if (!otherModel.ok || !noTable.ok) throw new Error("models failed");
    const thing = randomUUID();
    const loose = randomUUID();
    await insertEntries(backend, other.workspaceId, otherModel.data.model.id, [{ id: thing, status: "draft", draft: { data: { title: "Thing" }, locale: "en" } }]);
    await insertEntries(backend, other.workspaceId, noTable.data.model.id, [{ id: loose, status: "draft", draft: { data: { title: "Loose" }, locale: "en" } }]);
    await bringModelTableUp({ workspaceId: other.workspaceId, modelId: otherModel.data.model.id, actor: other.adminUserId });

    // A deleted entry: its rows go with it (the table's foreign key cascades).
    const postTable = await tableOf(backend, install.postModelId);
    const doomed = install.posts[install.posts.length - 1];
    await backend.query("delete from content_entries where id = $1", [doomed]);
    expect(await backend.query(`select 1 from content.${postTable} where _entry_id = $1`, [doomed])).toEqual([]);

    const ids = [install.posts[10], install.people[3], thing, loose, randomUUID(), doomed, install.posts[10]];
    const result = await syncEntries(db, ids);
    expect(result).toEqual({ requested: 6, synced: 3, skipped_no_table: 1, missing: 2, failed: [] });
    for (const [workspaceId, modelId] of [[install.workspaceId, install.postModelId], [install.workspaceId, install.personModelId], [other.workspaceId, otherModel.data.model.id]]) {
      expect(await verifyModel(db, { workspaceId, modelId })).toMatchObject({ matched: true });
    }
    const thingTable = await tableOf(backend, otherModel.data.model.id);
    expect((await backend.query<{ id: string }>(`select _entry_id as id from content.${thingTable}`)).map((r) => r.id)).toEqual([thing]);
    install.posts.pop();
  });

  it("workspace isolation: another workspace reads nothing of this model through the switched read path", async () => {
    const { workspaceId, postModelId } = install;
    await setReadSource(getDb(), { workspaceId, modelId: postModelId, source: "table" });
    const other = await backend.createWorkspace();
    expect(await tableSource(other.workspaceId, postModelId)).toBeNull();
    expect(await listEntries(other.workspaceId, postModelId)).toEqual([]);
    expect(await currentVersionsOfModel(other.workspaceId, postModelId)).toEqual([]);
    expect(await listPublishedContent({ workspaceId: other.workspaceId, modelApiKey: install.postKey })).toMatchObject({ model: null, records: [] });
    // Even with this model's table in hand, rows are only read joined to the caller's workspace.
    const source = (await tableSource(workspaceId, postModelId))!;
    expect(await readTableRows(other.workspaceId, source)).toEqual([]);
    expect((await readTableRows(workspaceId, source, { entryIds: install.posts.slice(0, 3) })).length).toBeGreaterThan(0);
    // The policy on content.m_* is the app's permissive one, like every public table: isolation is the
    // read path's job, and the read path always resolves the table through the caller's workspace.
    const [policy] = await backend.query<{ qual: string }>("select qual from pg_policies where schemaname = 'content' and tablename = $1", [source.table]);
    expect(policy.qual).toBe("true");
    await setReadSource(getDb(), { workspaceId, modelId: postModelId, source: "snapshot" });
  });

  it("the functions run as the owner with an empty search_path, for the app only; the new tables are read-only for the app", async () => {
    const { rows } = await owner.query(
      `select p.proname, p.prosecdef, p.proconfig, pg_get_userbyid(p.proowner) as owner,
              has_function_privilege('polynovea_app', p.oid, 'execute') as app,
              exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where a.grantee = 0 and a.privilege_type = 'EXECUTE') as public_exec,
              exists (select 1 from pg_roles r where r.rolname = 'service_role' and has_function_privilege(r.oid, p.oid, 'execute')) as service_role
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname in ('polynovea_content_sync_entries', 'polynovea_content_verify_model', 'polynovea_content_set_read_source', 'polynovea_content_entries_sync')
        order by 1`,
    );
    expect(rows).toHaveLength(4);
    for (const row of rows) {
      expect(row).toMatchObject({ prosecdef: true, owner: "polynovea_owner", app: true, public_exec: false, service_role: false });
      expect(row.proconfig).toContain('search_path=""');
    }
    for (const pass of ["after the migrations", "after the helper runs again"]) {
      if (pass !== "after the migrations") await owner.query("select public.polynovea_apply_app_access()");
      for (const table of ["content_model_storage", "content_model_move_runs"]) {
        const { rows: [p] } = await owner.query(
          `select has_table_privilege('polynovea_app', $1, 'select') as s, has_table_privilege('polynovea_app', $1, 'insert') as i,
                  has_table_privilege('polynovea_app', $1, 'update') as u, has_table_privilege('polynovea_app', $1, 'delete') as d`, [`public.${table}`]);
        expect({ table, pass, ...p }).toEqual({ table, pass, s: true, i: false, u: false, d: false });
        await expect(app.query(`delete from public.${table} where false`)).rejects.toMatchObject({ code: "42501" });
      }
    }
    // Errors carry a code, never data.
    expect(await errorOf(app.query("select public.polynovea_content_set_read_source($1, $2, 'table')", [randomUUID(), randomUUID()]))).toEqual({ code: "P0002", message: "content_model_not_found" });
    expect(await errorOf(app.query("select public.polynovea_content_sync_entries($1::uuid[])", [Array.from({ length: 1001 }, () => randomUUID())]))).toEqual({ code: "22023", message: "content_sync_batch_too_large" });
    const { rows: [state] } = await owner.query("select schema_migration from cms_runtime_state where singleton = true");
    expect(state.schema_migration >= "0076").toBe(true);
  });

  it("saves keep the table in step with one sync per statement: 1,000 entries in bulk and 1,000 single saves, timed", async () => {
    const { workspaceId, postModelId } = install;
    const table = await tableOf(backend, postModelId);
    const ids = Array.from({ length: 1_000 }, () => randomUUID());
    const bulkStart = Date.now();
    await insertEntries(backend, workspaceId, postModelId, ids.map((id, n) => ({ id, status: "draft", draft: { data: { title: `Bulk ${n}`, slug: `bulk-${n}`, views: n }, locale: "en" } })));
    const bulkMs = Date.now() - bulkStart;
    const [count] = await backend.query<{ n: string }>(`select count(*) as n from content.${table} where _entry_id = any ($1::uuid[])`, [ids]);
    expect(Number(count.n)).toBe(1_000);

    const versions = await backend.query<{ id: string; entry_id: string }>(
      `insert into content_entry_versions (entry_id, model_schema_version, version_number, data_jsonb, locale)
       select id, 1, 2, jsonb_build_object('title', 'Saved ' || ord, 'slug', 'saved-' || ord), 'en' from unnest($1::uuid[]) with ordinality as x(id, ord) returning id, entry_id`, [ids]);
    const singleStart = Date.now();
    for (const version of versions) await backend.query("update content_entries set current_draft_version_id = $1 where id = $2", [version.id, version.entry_id]);
    const singleMs = Date.now() - singleStart;
    const [saved] = await backend.query<{ n: string }>(`select count(*) as n from content.${table} where _entry_id = any ($1::uuid[]) and title like 'Saved %'`, [ids]);
    expect(Number(saved.n)).toBe(1_000);
    // An update that does not touch the pointers does not sync at all.
    const statusStart = Date.now();
    await backend.query("update content_entries set updated_at = now() where id = any ($1::uuid[])", [ids]);
    const untouchedMs = Date.now() - statusStart;
    report("trigger_timing", { bulkInsert1000Ms: bulkMs, singleSaves1000Ms: singleMs, perSaveMs: Number((singleMs / 1000).toFixed(2)), nonPointerUpdate1000Ms: untouchedMs });
    expect(bulkMs).toBeLessThan(30_000);
    expect(singleMs).toBeLessThan(60_000);
    expect(await verifyModel(getDb(), { workspaceId, modelId: postModelId })).toMatchObject({ matched: true });
  });

  it("renaming a search-indexed field keeps search working through expand, switch and contract; the old index goes at the contract", async () => {
    const { workspaceId, adminUserId } = await backend.createWorkspace();
    await backend.query("insert into workspace_members (workspace_id, admin_user_id, status) values ($1, $2, 'active')", [workspaceId, adminUserId]);
    const apiKey = uniqueKey("doc");
    const created = await createModel({ workspaceId, createdBy: adminUserId, proposedSchema: { name: "Doc", apiKey, fields: [field({ key: "title", type: "text" })] } });
    if (!created.ok) throw new Error(created.error);
    const modelId = created.data.model.id;
    for (const title of ["Kubernetes guide", "Gardening tips"]) {
      const entry = await createEntry({ workspaceId, modelId, data: { title }, actorAdminUserId: adminUserId });
      if (!entry.ok) throw new Error(entry.error);
    }
    expect((await bringModelTableUp({ workspaceId, modelId, actor: adminUserId, switchReads: true })).verify.matched).toBe(true);
    const table = (await tableOf(backend, modelId))!;
    const search = async () => (await searchContent({ workspaceId, modelId, query: "Kubernet" })).length;
    const indexNames = async () => (await backend.query<{ indexname: string }>("select indexname from pg_indexes where schemaname = 'content' and tablename = $1", [table])).map((r) => r.indexname);
    expect(await search()).toBe(1);

    const model = (await getModel(workspaceId, modelId))!;
    const changed = await applyChange({ model, proposedSchema: { name: "Doc", apiKey, fields: [field({ key: "headline", type: "text" })] }, acknowledgeUnsafe: true, actorAdminUserId: adminUserId });
    if (!changed.ok || !changed.data.version) throw new Error("version 2 not created");
    await requestSchemaChange(getDb(), { contentModelId: modelId, targetVersionId: changed.data.version.id, renames: [{ from: "title", to: "headline" }], requestedBy: adminUserId, limits: TEST_LIMITS });
    expect(await runWorker(modelId)).toEqual(["succeeded"]);
    // Expanded and switched: both columns carry a search index until the contract.
    expect(await indexNames()).toEqual(expect.arrayContaining([derivedName("tg", table, "title"), derivedName("tg", table, "headline")]));
    expect((await bringModelTableUp({ workspaceId, modelId, actor: adminUserId, switchReads: true })).verify.matched).toBe(true);
    expect(await search()).toBe(1);

    // The contract (a newer release, past the minimum wait) drops the old column and its index.
    await backend.query("update schema_expand_contract_tasks set contract_min_at = now() - interval '1 minute' where content_model_id = $1", [modelId]);
    await runWorker(modelId, { contracts: true, releaseId: "test-release-next" });
    const after = await indexNames();
    expect(after).toContain(derivedName("tg", table, "headline"));
    expect(after).not.toContain(derivedName("tg", table, "title"));
    expect((await bringModelTableUp({ workspaceId, modelId, actor: adminUserId, switchReads: true })).verify.matched).toBe(true);
    expect(await search()).toBe(1);
  });

  it("after a schema change (rename + add) the worker re-syncs the model by itself and its reads return to the table", async () => {
    const { workspaceId, adminUserId } = await backend.createWorkspace();
    await backend.query("insert into workspace_members (workspace_id, admin_user_id, status) values ($1, $2, 'active')", [workspaceId, adminUserId]);
    const apiKey = uniqueKey("auto");
    const created = await createModel({ workspaceId, createdBy: adminUserId, proposedSchema: { name: "Auto", apiKey, fields: [field({ key: "title", type: "text" }), field({ key: "count", type: "integer" })] } });
    if (!created.ok) throw new Error(created.error);
    const modelId = created.data.model.id;
    const ids = Array.from({ length: 1_200 }, () => randomUUID());
    await insertEntries(backend, workspaceId, modelId, ids.map((id, n) => ({
      id, status: n % 2 ? "published" : "draft",
      ...(n % 2 ? { published: { data: { title: `T${n}`, count: n }, locale: "en" } } : { draft: { data: { title: `D${n}`, count: n }, locale: "en" } }),
    })));
    expect((await bringModelTableUp({ workspaceId, modelId, actor: adminUserId, switchReads: true })).verify.matched).toBe(true);
    expect(await tableSource(workspaceId, modelId)).not.toBeNull();

    const model = (await getModel(workspaceId, modelId))!;
    const changed = await applyChange({ model, proposedSchema: { name: "Auto", apiKey, fields: [field({ key: "headline", type: "text" }), field({ key: "count", type: "integer" }), field({ key: "extra", type: "text" })] }, acknowledgeUnsafe: true, actorAdminUserId: adminUserId });
    if (!changed.ok || !changed.data.version) throw new Error("version 2 not created");
    await requestSchemaChange(getDb(), { contentModelId: modelId, targetVersionId: changed.data.version.id, renames: [{ from: "title", to: "headline" }], requestedBy: adminUserId, limits: TEST_LIMITS });
    // While the change waits for the worker, reads are on the snapshots.
    expect(await tableSource(workspaceId, modelId)).toBeNull();
    expect(await runWorker(modelId)).toEqual(["succeeded"]);

    // No content:move: the worker's own run matched the new shape, and reads are on the table again.
    expect(await readSourceOf(getDb(), modelId)).toBe("table");
    const source = await tableSource(workspaceId, modelId);
    expect(source).not.toBeNull();
    const [state] = await backend.query<{ run_id: string; matched: boolean; requested_by: string | null; backfill: Record<string, number> }>(
      `select r.id as run_id, r.matched, r.requested_by, r.backfill from content_model_storage s join content_model_move_runs r on r.id = s.last_run_id
        join content_model_tables t on t.content_model_id = s.content_model_id and t.applied_shape_hash = r.shape_hash where s.content_model_id = $1`, [modelId]);
    expect(state).toMatchObject({ matched: true, requested_by: null, backfill: { batches: 2, entries: 1_200, failed: 0 } });
    const run = (await moveRun(getDb(), state.run_id))!;
    expect(run.counts.snapshot).toMatchObject({ draft: 600, published: 600 });
    expect(run.counts.table).toMatchObject({ draft: 600, published: 600 });
    expect(Object.values(run.fields).map((f) => f.field).sort()).toEqual(["count", "extra", "headline"]);
    // The renamed field reads its values from snapshots saved under the old key.
    const rows = await readTableRows(workspaceId, source!, { entryIds: [ids[1]] });
    expect(rows.map((row) => row.data)).toEqual([{ headline: "T1", count: 1 }]);
    report("auto_resync", { entries: ids.length, counts: run.counts, fields: Object.keys(run.fields).length });

    // The sync reads the aliases stored with the table when the stage succeeded; the verification
    // derives them from the ledger on its own. So a wrong stored alias is caught as a mismatch.
    const [stored] = await backend.query<{ field_aliases: Record<string, Array<{ name: string; below: number }>> }>(
      "select field_aliases from content_model_tables where content_model_id = $1", [modelId]);
    const [headlineColumn] = Object.keys(stored.field_aliases);
    expect(stored.field_aliases).toEqual({ [headlineColumn]: [{ name: "title", below: changed.data.version.version_number }] });
    await owner.query("update content_model_tables set field_aliases = '{}'::jsonb where content_model_id = $1", [modelId]);
    await backfillModel(getDb(), { workspaceId, modelId });
    const tampered = await verifyModel(getDb(), { workspaceId, modelId });
    expect(tampered.matched).toBe(false);
    expect(tampered.mismatches).toEqual(expect.arrayContaining([
      { kind: "field_checksum", column: headlineColumn, variant: "draft" }, { kind: "field_checksum", column: headlineColumn, variant: "published" }]));
    expect(await tableSource(workspaceId, modelId)).toBeNull();
    await owner.query("update content_model_tables set field_aliases = public.polynovea_content_field_aliases(content_model_id, applied_shape) where content_model_id = $1", [modelId]);
    await backfillModel(getDb(), { workspaceId, modelId });
    expect(await verifyModel(getDb(), { workspaceId, modelId })).toMatchObject({ matched: true, mismatches: [] });
    expect(await tableSource(workspaceId, modelId)).not.toBeNull();
  });

  it("the worker's re-sync records a failed run and backs off per model, doubling up to an hour", async () => {
    const { workspaceId, adminUserId } = await backend.createWorkspace();
    await backend.query("insert into workspace_members (workspace_id, admin_user_id, status) values ($1, $2, 'active')", [workspaceId, adminUserId]);
    const created = await createModel({ workspaceId, createdBy: adminUserId, proposedSchema: { name: "Backoff", apiKey: uniqueKey("backoff"), fields: [field({ key: "title", type: "text" }), field({ key: "count", type: "integer" })] } });
    if (!created.ok) throw new Error(created.error);
    const modelId = created.data.model.id;
    const ids = Array.from({ length: 20 }, () => randomUUID()).sort();
    await insertEntries(backend, workspaceId, modelId, ids.map((id, n) => ({ id, status: "published", published: { data: { title: `T${n}`, count: n }, locale: "en" } })));
    expect((await bringModelTableUp({ workspaceId, modelId, actor: adminUserId })).verify.matched).toBe(true);
    const db = getDb();
    const due = async () => (await modelsNeedingResync(db, { modelId })).map((m) => m.modelId);
    const events: Array<{ event: string; fields: Record<string, unknown> }> = [];
    const resync = () => resyncChangedModels(db, { modelId, log: (event, fields) => events.push({ event, fields }) });
    const age = (seconds: number) => owner.query(
      "update content_model_move_runs set finished_at = finished_at - make_interval(secs => $2) where id = (select last_run_id from content_model_storage where content_model_id = $1)", [modelId, seconds]);
    expect(await due()).toEqual([]);

    // A save that cannot reach the table: due at once.
    const [bad] = await backend.query<{ id: string }>("select published_version_id as id from content_entries where id = $1", [ids[4]]);
    await backend.query("update content_entry_versions set data_jsonb = $1 where id = $2", [JSON.stringify({ title: "T4", count: "four" }), bad.id]);
    await syncEntries(db, [ids[4]]);
    expect(await due()).toEqual([modelId]);
    expect(await resync()).toBe(1);
    expect(events.at(-1)).toMatchObject({ event: "content_resynced", fields: { modelId, matched: false, failedEntries: 1 } });
    // Unmatched once: 1 minute's pause.
    expect(await due()).toEqual([]);
    await age(61);
    expect(await due()).toEqual([modelId]);
    expect(await resync()).toBe(1);
    // Unmatched twice in a row: 2 minutes.
    await age(61);
    expect(await due()).toEqual([]);
    await age(60);
    expect(await due()).toEqual([modelId]);

    // A re-sync that fails part-way (the model's intent is 'table', so the bad entry fails its batch)
    // is still verified: the failure is a recorded, unmatched run, and the pause doubles again.
    await owner.query("update content_model_storage set read_source = 'table' where content_model_id = $1", [modelId]);
    expect(await resync()).toBe(1);
    expect(events.at(-1)).toMatchObject({ event: "content_resync_failed", fields: { modelId, matched: false, code: "22P02:content_table_write_failed" } });
    expect(events.at(-1)!.fields.runId).toEqual(expect.any(String));
    await age(3 * 60 + 1);
    expect(await due()).toEqual([]);
    await age(60);
    expect(await due()).toEqual([modelId]);

    // The pause never exceeds an hour, however many runs failed.
    for (let n = 0; n < 4; n += 1) { await age(3_601); expect(await resync()).toBe(1); }
    expect(await due()).toEqual([]);
    await age(3_601);
    expect(await due()).toEqual([modelId]);

    // Fixed content: the next try matches, and reads return to the table.
    await backend.query("update content_entry_versions set data_jsonb = $1 where id = $2", [JSON.stringify({ title: "T4", count: 4 }), bad.id]);
    expect(await resync()).toBe(1);
    expect(events.at(-1)).toMatchObject({ event: "content_resynced", fields: { modelId, matched: true, reads: "table" } });
    expect(await tableSource(workspaceId, modelId)).not.toBeNull();
    expect(await due()).toEqual([]);
    await owner.query("update content_model_storage set read_source = 'snapshot' where content_model_id = $1", [modelId]);
  });

  it("random sequences of model changes, each applied and reverted, keep the table matching the snapshots", async () => {
    const { workspaceId, adminUserId } = await backend.createWorkspace();
    await backend.query("insert into workspace_members (workspace_id, admin_user_id, status) values ($1, $2, 'active')", [workspaceId, adminUserId]);
    const apiKey = uniqueKey("seq");
    const base = [field({ key: "title", type: "text" }), field({ key: "count", type: "integer" }), field({ key: "summary", type: "text" })];
    const created = await createModel({ workspaceId, createdBy: adminUserId, proposedSchema: { name: "Seq", apiKey, fields: base } });
    if (!created.ok) throw new Error(created.error);
    const modelId = created.data.model.id;
    const ids = Array.from({ length: 300 }, () => randomUUID());
    await insertEntries(backend, workspaceId, modelId, ids.map((id, n) => ({
      id, status: n % 2 ? "published" : "draft",
      ...(n % 2 ? { published: { data: { title: `T${n}`, count: n, summary: `S${n}`, later: `L${n}` }, locale: "en" } } : {}),
      ...(n % 3 ? { draft: { data: { title: `D${n}`, count: String(n), summary: n % 5 ? `S${n}` : null, later: n }, locale: "en" } } : {}),
    })));
    expect((await bringModelTableUp({ workspaceId, modelId, actor: adminUserId })).verify.matched).toBe(true);

    // Each change: a new schema version, applied and then reverted (the previous fields again).
    const changes: Array<{ name: string; apply: (fields: FieldDefinition[]) => FieldDefinition[] }> = [
      { name: "add a field the snapshots already hold", apply: (f) => [...f, field({ key: "later", type: "text" })] },
      { name: "widen integer to number", apply: (f) => f.map((x) => (x.key === "count" ? { ...x, type: "number" as const } : x)) },
      { name: "text to long text", apply: (f) => f.map((x) => (x.key === "summary" ? { ...x, type: "long_text" as const } : x)) },
      { name: "text to slug (search index dropped)", apply: (f) => f.map((x) => (x.key === "title" ? { ...x, type: "slug" as const } : x)) },
      { name: "add an indexed integer", apply: (f) => [...f, field({ key: "rank", type: "integer", index: true })] },
    ];
    let seed = 7;
    const random = () => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed / 2 ** 31; };
    const order = [...changes].sort(() => random() - 0.5);
    const results: Array<{ change: string; applied: boolean; reverted: boolean }> = [];
    let fields = base;
    for (const change of order) {
      const outcome = { change: change.name, applied: false, reverted: false };
      for (const [step, next] of [["applied", change.apply(fields)], ["reverted", fields]] as const) {
        const model = (await getModel(workspaceId, modelId))!;
        const applied = await applyChange({ model, proposedSchema: { name: "Seq", apiKey, fields: next }, acknowledgeUnsafe: true, actorAdminUserId: adminUserId });
        if (!applied.ok) throw new Error(applied.error);
        const up = await bringModelTableUp({ workspaceId, modelId, actor: adminUserId });
        expect({ change: change.name, step, outcomes: up.outcomes.every((o) => o === "succeeded"), mismatches: up.verify.mismatches })
          .toEqual({ change: change.name, step, outcomes: true, mismatches: [] });
        outcome[step] = up.verify.matched;
      }
      results.push(outcome);
    }
    report("random_sequence", { seed: 7, entries: ids.length, results });
  });
});
