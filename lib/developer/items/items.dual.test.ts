// The generated items API on real PostgreSQL (Phase 4, wave 1): the permission matrix generated from
// fixture roles, every expensive-query limit, cursors, preview gating, writes, and the statement
// timeout. Runs as the app role through getDb(); tables built by the schema worker (testing helper).
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { sql } from "kysely";
import { describeWithDatabase, type BackendFixtures } from "@/lib/db/testing/database";
import { getDb } from "@/lib/db/index";
import { uniqueKey } from "@/lib/schema/engine/testing";
import { createModel } from "@/lib/schema/modelService";
import { bringModelTableUp, closeTableMoveSession } from "@/lib/content/testing/tableMove";
import { setReadSource } from "@/lib/content/contentMove";
import { indexEntry, searchContent } from "@/lib/content/searchService";
import { getEntry, listEntryVersions } from "@/lib/content/entryService";
import { createPreviewToken } from "@/lib/content/previewService";
import { listDeveloperEntries } from "@/lib/developer/resourceService";
import { logDeveloperApiMutation } from "@/lib/developer/developerAudit";
import type { DeveloperApiContext } from "@/lib/developer/apiAuth";
import type { FieldDefinition } from "@/lib/schema/fields/types";
import { ItemsApiError } from "@/lib/developer/items/errors";
import { principalForToken, previewScope } from "@/lib/developer/items/principal";
import { createItem, deleteItem, getItem, listItems, updateItem, withReadTimeout, type ItemsContext } from "@/lib/developer/items/service";
import { adminAccesses } from "@/lib/developer/items/sideChannels";
import { sanitiseLegacyPayload, tokenAccesses } from "@/lib/developer/items/legacy";
import { scheduledPublishCheck } from "@/lib/developer/items/schedule";
import { recordPlatformEvent } from "@/lib/platform/audit.postgres";

const SECRET = `TOP-SECRET-${randomUUID().slice(0, 8)}`;
const SALARY = 987654;
const report = (label: string, value: unknown) => console.log(`[items-matrix] ${label} ${JSON.stringify(value)}`);
const f = (key: string, type: FieldDefinition["type"], extra: Partial<FieldDefinition> = {}): FieldDefinition =>
  ({ key, label: key, type, required: false, localized: false, unique: false, ...extra } as FieldDefinition);

interface Fixture {
  workspaceId: string;
  adminUserId: string;
  roles: Record<"owner" | "editor" | "writer" | "viewer" | "limited", string>;
  article: { id: string; apiKey: string };
  person: { id: string; apiKey: string };
  people: string[];
  articles: string[];
  draftOnly: string;
}

async function insertEntries(backend: BackendFixtures, workspaceId: string, modelId: string, rows: Array<{ id: string; status: string; draft?: unknown; published?: unknown }>) {
  for (const row of rows) {
    await backend.query("insert into content_entries (id, workspace_id, content_model_id, status) values ($1, $2, $3, $4)", [row.id, workspaceId, modelId, row.status]);
    let n = 0;
    let publishedId: string | null = null;
    let draftId: string | null = null;
    if (row.published) {
      publishedId = randomUUID();
      await backend.query("insert into content_entry_versions (id, entry_id, model_schema_version, version_number, data_jsonb, locale, state) values ($1, $2, 1, $3, $4::jsonb, 'en', 'published')", [publishedId, row.id, ++n, JSON.stringify(row.published)]);
    }
    if (row.draft) {
      draftId = randomUUID();
      await backend.query("insert into content_entry_versions (id, entry_id, model_schema_version, version_number, data_jsonb, locale, state) values ($1, $2, 1, $3, $4::jsonb, 'en', 'draft')", [draftId, row.id, ++n, JSON.stringify(row.draft)]);
    }
    await backend.query("update content_entries set current_draft_version_id = $2, published_version_id = $3 where id = $1", [row.id, draftId, publishedId]);
  }
}

async function fixture(backend: BackendFixtures): Promise<Fixture> {
  const { workspaceId, adminUserId } = await backend.createWorkspace();
  const [member] = await backend.query<{ id: string }>("insert into workspace_members (workspace_id, admin_user_id, status) values ($1, $2, 'active') returning id", [workspaceId, adminUserId]);
  const roles = {} as Fixture["roles"];
  for (const key of ["owner", "editor", "writer", "viewer", "limited"] as const) {
    const [role] = await backend.query<{ id: string }>("insert into roles (workspace_id, key, name) values ($1, $2, $2) returning id", [workspaceId, key]);
    roles[key] = role.id;
  }
  await backend.query("insert into member_roles (workspace_member_id, role_id) values ($1, $2)", [member.id, roles.owner]);
  for (const permission of ["content.entry.read", "content.entry.edit", "content.entry.publish"]) {
    await backend.query("insert into role_permissions (role_id, permission_key) values ($1, $2) on conflict do nothing", [roles.owner, permission]);
  }
  await backend.query("update roles set api_limits = $2::jsonb where id = $1", [roles.limited, JSON.stringify({ pageSize: 2, joins: 0, filterDepth: 1 })]);

  const personKey = uniqueKey("person");
  const articleKey = uniqueKey("article");
  const person = await createModel({ workspaceId, createdBy: adminUserId, proposedSchema: { name: "Person", apiKey: personKey, fields: [f("name", "text", { required: true }), f("salary", "integer")] } });
  if (!person.ok) throw new Error(person.error);
  const article = await createModel({ workspaceId, createdBy: adminUserId, proposedSchema: { name: "Article", apiKey: articleKey, fields: [
    f("title", "text", { required: true }), f("secret", "text"), f("rating", "integer"), f("featured", "boolean"),
    f("author", "relation", { relation: { targetModelApiKey: personKey, cardinality: "many_to_one", onDelete: "remove_reference" } }),
  ] } });
  if (!article.ok) throw new Error(article.error);
  const personId = person.data.model.id;
  const articleId = article.data.model.id;

  const rule = (modelId: string, field: string, role: string, read: boolean, write: boolean) =>
    backend.query("insert into content_field_permissions (workspace_id, content_model_id, field_key, role_id, can_read, can_write) values ($1, $2, $3, $4, $5, $6)", [workspaceId, modelId, field, role, read, write]);
  await rule(articleId, "secret", roles.editor, false, false);
  await rule(articleId, "secret", roles.writer, false, true);
  await rule(articleId, "title", roles.writer, true, false);
  await rule(personId, "salary", roles.editor, false, false);
  await rule(articleId, "secret", roles.limited, false, false);

  const people = [randomUUID(), randomUUID()];
  await insertEntries(backend, workspaceId, personId, people.map((id, i) => ({ id, status: "published", published: { name: `Person ${i}`, salary: SALARY + i } })));
  const articles = Array.from({ length: 5 }, () => randomUUID());
  await insertEntries(backend, workspaceId, articleId, articles.map((id, i) => ({
    id, status: "published",
    published: { title: `Alpha ${i}`, secret: i === 0 ? `${SECRET} zebraword` : `${SECRET}-${i}`, rating: i, featured: i % 2 === 0, author: people[i % 2] },
    ...(i === 0 ? { draft: { title: "Alpha 0 draft", secret: SECRET, rating: 0, featured: true, author: people[0] } } : {}),
  })));
  const draftOnly = randomUUID();
  await insertEntries(backend, workspaceId, articleId, [{ id: draftOnly, status: "draft", draft: { title: "Unpublished", secret: SECRET, rating: 9 } }]);
  for (const modelId of [personId, articleId]) {
    const up = await bringModelTableUp({ workspaceId, modelId, actor: adminUserId, switchReads: true });
    if (!up.verify.matched) throw new Error(`table for ${modelId} did not match`);
  }
  // The search documents every save writes (search_text holds every string field, the hidden one too).
  for (const id of [...people, ...articles]) {
    const entry = await getEntry(workspaceId, id);
    const published = (await listEntryVersions(workspaceId, id)).find((version) => version.id === entry?.published_version_id);
    if (entry && published) await indexEntry(entry, published);
  }
  return { workspaceId, adminUserId, roles, article: { id: articleId, apiKey: articleKey }, person: { id: personId, apiKey: personKey }, people, articles, draftOnly };
}

const ALL_SCOPES = ["content.read", "content.write", "content.delete", "content.preview", "schema.read"];

function apiCtx(fx: Fixture, roleId: string | null, over: Partial<DeveloperApiContext> = {}): DeveloperApiContext {
  return {
    requestId: "r", workspaceId: fx.workspaceId, tokenId: `token-${roleId ?? "none"}`, tokenName: "t", actorAdminUserId: fx.adminUserId,
    scopes: ALL_SCOPES, allowedModels: [], rateLimit: { limit: 100, remaining: 99, resetAt: "" }, agentIdentityId: null, agentToolName: null, roleId, ...over,
  };
}

async function ctxFor(fx: Fixture, roleId: string | null, over: Partial<DeveloperApiContext> = {}, drafts: ItemsContext["drafts"] = { allowed: true, entryIds: null }): Promise<ItemsContext> {
  const api = apiCtx(fx, roleId, over);
  return { principal: await principalForToken(getDb(), api), callerId: api.tokenId, actorAdminUserId: fx.adminUserId, drafts };
}

const P = (values: Record<string, string>) => new URLSearchParams(values);
async function refusal(promise: Promise<unknown>) {
  try { await promise; } catch (error) { if (error instanceof ItemsApiError) return { code: error.code, status: error.status, details: error.details }; throw error; }
  throw new Error("expected a refusal");
}
const strip = (r: { details?: unknown }) => ({ ...r, details: Object.keys((r.details ?? {}) as object).sort() });

describeWithDatabase("generated items API [postgres]", (backend) => {
  let fx: Fixture;
  beforeAll(async () => { fx = await fixture(backend); }, 120_000);
  afterAll(async () => { await closeTableMoveSession(); });

  it("permission matrix: every restricted field is unreachable through every channel, for every restricting role", async () => {
    // [role, model, field, the hidden value]
    const cells = [
      ["editor", () => fx.article.apiKey, "secret", SECRET],
      ["writer", () => fx.article.apiKey, "secret", SECRET],
      ["editor", () => fx.person.apiKey, "salary", String(SALARY)],
    ] as const;
    const results: Record<string, string> = {};
    const owner = await ctxFor(fx, fx.roles.owner);

    for (const [role, modelOf, field, hidden] of cells) {
      const model = modelOf();
      const ctx = await ctxFor(fx, fx.roles[role]);
      const label = `${role}:${field}`;

      // Control: the owner reaches the field, so each negative cell is meaningful.
      const ownerList = await listItems(owner, model, P({ limit: "10" }));
      expect(ownerList.items.some((item) => field in item.data)).toBe(true);

      // 1. output
      const list = await listItems(ctx, model, P({ limit: "2" }));
      expect(JSON.stringify(list.items)).not.toContain(hidden);
      expect(list.items.every((item) => !(field in item.data))).toBe(true);
      results[`${label}:output`] = "pass";

      // 2. filter: identical to a field that does not exist
      const op = field === "salary" ? { gt: 0 } : { contains: "SECRET" };
      const hiddenFilter = await refusal(listItems(ctx, model, P({ filter: JSON.stringify({ [field]: op }) })));
      const missingFilter = await refusal(listItems(ctx, model, P({ filter: JSON.stringify({ [`${field}x`]: op }) })));
      expect(hiddenFilter.code).toBe("UNKNOWN_FIELD");
      expect(strip(hiddenFilter)).toEqual(strip(missingFilter));
      results[`${label}:filter`] = "pass";

      // 3. sort
      const hiddenSort = await refusal(listItems(ctx, model, P({ sort: `-${field}` })));
      expect(strip(hiddenSort)).toEqual(strip(await refusal(listItems(ctx, model, P({ sort: `-${field}x` })))));
      results[`${label}:sort`] = "pass";

      // 4. search: a term only in the hidden field finds nothing, and a visible term finds the same rows in the same order
      if (field === "secret") {
        expect((await listItems(owner, model, P({ search: "zebraword" }))).items.length).toBe(1);
        expect((await listItems(ctx, model, P({ search: "zebraword" }))).items).toEqual([]);
        const visible = (await listItems(ctx, model, P({ search: "Alpha", limit: "10" }))).items.map((item) => item.id);
        expect(visible.length).toBe(5);
        // Admin search (cross-channel): same rule.
        const accesses = await adminAccesses(getDb(), fx.workspaceId, fx.adminUserId, "admin", [model]);
        const access = accesses!.get(model)!;
        const readableKeys = new Set([...access.readable].filter((key) => key !== field));
        const restrictedScope = { restricted: new Map([[access.model.id, readableKeys]]), readableModelIds: [access.model.id], readable: new Map([[access.model.id, readableKeys]]) };
        // Control: without a field scope the stored document matches the hidden term.
        expect((await searchContent({ workspaceId: fx.workspaceId, query: "zebraword" })).length).toBeGreaterThan(0);
        const docs = await searchContent({ workspaceId: fx.workspaceId, query: "zebraword", fieldScope: restrictedScope });
        expect(docs).toEqual([]);
        const titled = await searchContent({ workspaceId: fx.workspaceId, query: "Alpha", modelId: access.model.id, fieldScope: restrictedScope });
        expect(JSON.stringify(titled)).not.toContain(hidden);
        // No query (nothing matched or ranked): snippets are still rebuilt from readable fields only.
        const listed = await searchContent({ workspaceId: fx.workspaceId, modelId: access.model.id, fieldScope: restrictedScope });
        expect(listed.length).toBeGreaterThan(0);
        expect(JSON.stringify(listed)).not.toContain(hidden);
        expect(listed.some((row) => (row.search_text ?? "").includes("Alpha"))).toBe(true);
        results[`${label}:search`] = "pass";
      }

      // 5. expansion: into the person model, salary is gone; through a hidden relation, UNKNOWN_FIELD
      if (model === fx.article.apiKey) {
        const expanded = await listItems(ctx, model, P({ expand: "author", limit: "5" }));
        const author = expanded.items[0].data.author as { data?: Record<string, unknown> };
        expect(typeof author).toBe("object");
        expect(JSON.stringify(expanded.items)).not.toContain(SECRET);
        expect((await refusal(listItems(ctx, model, P({ expand: field })))).code).toBe("UNKNOWN_FIELD");
        results[`${label}:expansion`] = "pass";
      } else {
        const viaArticle = await listItems(ctx, fx.article.apiKey, P({ expand: "author", limit: "5" }));
        expect(JSON.stringify(viaArticle.items)).not.toContain(String(SALARY));
        expect((await refusal(listItems(ctx, fx.article.apiKey, P({ filter: JSON.stringify({ author: { salary: { gt: 0 } } }) })))).code).toBe("UNKNOWN_FIELD");
        results[`${label}:expansion`] = "pass";
      }

      // 6. previews / drafts: the draft row is sanitised the same way
      const drafts = await listItems(ctx, model, P({ variant: "draft", limit: "10" }));
      expect(JSON.stringify(drafts.items)).not.toContain(hidden);
      results[`${label}:preview`] = "pass";

      // 7. MCP: the legacy entries route's payload
      const legacy = await listDeveloperEntries({ workspaceId: fx.workspaceId, modelApiKey: model, limit: 50, offset: 0 });
      const cleaned = sanitiseLegacyPayload(legacy.rows, await tokenAccesses(apiCtx(fx, fx.roles[role]), [model]));
      expect(JSON.stringify(legacy.rows)).toContain(hidden); // the raw rows have it...
      expect(JSON.stringify(cleaned)).not.toContain(hidden); // ...the route's response does not
      results[`${label}:mcp`] = "pass";
    }

    // 8. webhooks: after writes and audited mutations, no delivery payload carries a field value or a hidden key.
    await backend.query(
      "insert into webhook_subscriptions (workspace_id, name, endpoint_url, signing_secret_encrypted, signing_secret_hash, event_filters) values ($1, 'matrix', 'https://hooks.example.test/x', 'enc', $2, '{}')",
      [fx.workspaceId, randomUUID().replace(/-/g, "")],
    );
    const writer = await ctxFor(fx, fx.roles.writer);
    const updated = await updateItem(writer, fx.article.apiKey, fx.articles[1], { rating: 4 });
    await logDeveloperApiMutation(apiCtx(fx, fx.roles.writer), "developer.entry.updated", "content_entry", updated.item.id, { model: fx.article.apiKey, versionId: null });
    // A subscription owned by an editor, and an event that (unlike today's content events) carries
    // field data: the payload passes the owner's access, per subscription.
    const [editorAdmin] = await backend.query<{ id: string }>("insert into admin_users (username, email) values ($1, $1 || '@example.test') returning id", [`ed-${randomUUID().slice(0, 8)}`]);
    const [editorMember] = await backend.query<{ id: string }>("insert into workspace_members (workspace_id, admin_user_id, status) values ($1, $2, 'active') returning id", [fx.workspaceId, editorAdmin.id]);
    await backend.query("insert into member_roles (workspace_member_id, role_id) values ($1, $2)", [editorMember.id, fx.roles.editor]);
    await backend.query("insert into role_permissions (role_id, permission_key) values ($1, 'content.entry.read') on conflict do nothing", [fx.roles.editor]);
    await backend.query(
      "insert into webhook_subscriptions (workspace_id, name, endpoint_url, signing_secret_encrypted, signing_secret_hash, event_filters, created_by) values ($1, 'editor-owned', 'https://hooks.example.test/y', 'enc', $2, '{}', $3)",
      [fx.workspaceId, randomUUID().replace(/-/g, ""), editorAdmin.id],
    );
    await recordPlatformEvent(getDb(), {
      workspaceId: fx.workspaceId, actorAdminUserId: fx.adminUserId, action: "content.entry.updated", entityType: "content_entry", entityId: fx.articles[1],
      metadata: { model: fx.article.apiKey, data: { title: "Alpha 1", secret: SECRET }, changedFields: ["title", "secret"] },
    });
    const owned = await backend.query<{ payload_json: { metadata: Record<string, unknown> } }>(
      "select d.payload_json from webhook_deliveries d join webhook_subscriptions s on s.id = d.subscription_id where s.workspace_id = $1 and s.name = 'editor-owned' and d.event_type = 'content.entry.updated'", [fx.workspaceId]);
    expect(owned.length).toBe(1);
    expect(owned[0].payload_json.metadata).toMatchObject({ data: { title: "Alpha 1" }, changedFields: ["title"] });
    const deliveries = await backend.query<{ payload_json: unknown }>("select d.payload_json from webhook_deliveries d join webhook_subscriptions s on s.id = d.subscription_id where s.workspace_id = $1", [fx.workspaceId]);
    expect(deliveries.length).toBeGreaterThan(0);
    for (const delivery of deliveries) {
      const text = JSON.stringify(delivery.payload_json);
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain(String(SALARY));
      expect(text).not.toMatch(/"secret"|"salary"/);
    }
    for (const [role, , field] of cells) results[`${role}:${field}:webhooks`] = `pass (${deliveries.length} deliveries)`;

    // 9. table not ready: the snapshot path is sanitised too
    await setReadSource(getDb(), { workspaceId: fx.workspaceId, modelId: fx.article.id, source: "snapshot" });
    try {
      const editor = await ctxFor(fx, fx.roles.editor);
      const plain = await listItems(editor, fx.article.apiKey, P({ limit: "10" }));
      expect(plain.items.length).toBeGreaterThan(0);
      expect(JSON.stringify(plain.items)).not.toContain(SECRET);
      expect((await refusal(listItems(editor, fx.article.apiKey, P({ filter: JSON.stringify({ title: { eq: "Alpha 1" } }) })))).code).toBe("MODEL_TABLE_NOT_READY");
      expect((await refusal(listItems(editor, fx.article.apiKey, P({ filter: JSON.stringify({ secret: { eq: "x" } }) })))).code).toBe("UNKNOWN_FIELD");
      results["editor:secret:table-not-ready"] = "pass";
    } finally {
      await setReadSource(getDb(), { workspaceId: fx.workspaceId, modelId: fx.article.id, source: "table" });
    }
    report("matrix", results);
    expect(Object.values(results).every((value) => value.startsWith("pass"))).toBe(true);
  }, 180_000);

  it("published by default; a draft-only entry needs the draft variant; drafts need a preview grant", async () => {
    const editor = await ctxFor(fx, fx.roles.editor, {}, { allowed: false, entryIds: null });
    const published = await listItems(editor, fx.article.apiKey, P({ limit: "100" }));
    expect(published.items.map((item) => item.id)).not.toContain(fx.draftOnly);
    expect(published.items.find((item) => item.id === fx.articles[0])?.data.title).toBe("Alpha 0");
    expect((await refusal(listItems(editor, fx.article.apiKey, P({ variant: "draft" })))).code).toBe("PREVIEW_TOKEN_REQUIRED");

    // An entry preview token: drafts of that entry only.
    const { token } = await createPreviewToken({ workspaceId: fx.workspaceId, entryId: fx.articles[0], actorId: fx.adminUserId });
    const scope = await previewScope(getDb(), token);
    expect(scope).toMatchObject({ workspaceId: fx.workspaceId, entryIds: [fx.articles[0]] });
    const scoped = await ctxFor(fx, fx.roles.editor, {}, { allowed: true, entryIds: scope!.entryIds });
    const drafts = await listItems(scoped, fx.article.apiKey, P({ variant: "draft", limit: "100" }));
    expect(drafts.items.map((item) => item.id)).toEqual([fx.articles[0]]);
    expect(drafts.items[0].data.title).toBe("Alpha 0 draft");
    expect((await refusal(getItem(scoped, fx.article.apiKey, fx.draftOnly, P({ variant: "draft" })))).code).toBe("ITEM_NOT_FOUND");
    // Expired or unknown tokens give nothing.
    await backend.query("update preview_tokens set expires_at = now() - interval '1 minute' where entry_id = $1", [fx.articles[0]]);
    expect(await previewScope(getDb(), token)).toBeNull();
    expect(await previewScope(getDb(), "not-a-token")).toBeNull();
    // The content.preview scope reads every draft, the draft-only entry included.
    const preview = await ctxFor(fx, fx.roles.editor);
    expect((await listItems(preview, fx.article.apiKey, P({ variant: "draft", limit: "100" }))).items.map((item) => item.id)).toContain(fx.draftOnly);
  });

  it("filters, sorts and pages with signed cursors: every item once, in order; a cursor is tied to its token", async () => {
    const editor = await ctxFor(fx, fx.roles.editor);
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page = await listItems(editor, fx.article.apiKey, P({ sort: "-rating", limit: "2", ...(cursor ? { cursor } : {}) }));
      seen.push(...page.items.map((item) => item.id));
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor && pages < 10);
    expect(seen).toEqual([...fx.articles].reverse());
    const first = await listItems(editor, fx.article.apiKey, P({ sort: "-rating", limit: "2" }));
    const other = await ctxFor(fx, fx.roles.viewer);
    expect((await refusal(listItems(other, fx.article.apiKey, P({ sort: "-rating", limit: "2", cursor: first.nextCursor! })))).code).toBe("INVALID_CURSOR");
    expect((await refusal(listItems(editor, fx.article.apiKey, P({ sort: "rating", limit: "2", cursor: first.nextCursor! })))).code).toBe("INVALID_CURSOR");

    const filtered = await listItems(editor, fx.article.apiKey, P({ filter: JSON.stringify({ and: [{ rating: { gt: 1 } }, { featured: { eq: true } }] }), sort: "rating" }));
    expect(filtered.items.map((item) => item.data.rating)).toEqual([2, 4]);
    const hop = await listItems(editor, fx.article.apiKey, P({ filter: JSON.stringify({ author: { name: { eq: "Person 1" } } }), sort: "rating" }));
    expect(hop.items.map((item) => item.data.rating)).toEqual([1, 3]);
    const injected = await listItems(editor, fx.article.apiKey, P({ filter: JSON.stringify({ title: { contains: "%' or 1=1 --" } }) }));
    expect(injected.items).toEqual([]);
  });

  it("each expensive-query limit refuses on its own, and role overrides lower them", async () => {
    const editor = await ctxFor(fx, fx.roles.editor);
    const limited = await ctxFor(fx, fx.roles.limited);
    expect((await refusal(listItems(editor, fx.article.apiKey, P({ limit: "101" })))).code).toBe("PAGE_TOO_LARGE");
    expect((await refusal(listItems(limited, fx.article.apiKey, P({ limit: "3" })))).code).toBe("PAGE_TOO_LARGE");
    const deep = { and: [{ or: [{ not: { not: { rating: { eq: 1 } } } }] }] };
    expect((await refusal(listItems(editor, fx.article.apiKey, P({ filter: JSON.stringify(deep) })))).code).toBe("FILTER_TOO_DEEP");
    expect((await refusal(listItems(limited, fx.article.apiKey, P({ filter: JSON.stringify({ and: [{ or: [{ rating: { eq: 1 } }] }] }) })))).code).toBe("FILTER_TOO_DEEP");
    const many = { or: Array.from({ length: 21 }, (_, i) => ({ rating: { eq: i } })) };
    expect((await refusal(listItems(editor, fx.article.apiKey, P({ filter: JSON.stringify(many) })))).code).toBe("FILTER_TOO_COMPLEX");
    expect((await refusal(listItems(editor, fx.article.apiKey, P({ expand: "author.x.y" })))).code).toBe("EXPAND_TOO_DEEP");
    expect((await refusal(listItems(limited, fx.article.apiKey, P({ expand: "author" })))).code).toBe("TOO_MANY_JOINS");
    expect((await refusal(listItems(editor, fx.article.apiKey, P({ sort: "title,rating,featured,id" })))).code).toBe("INVALID_SORT");
  });

  it("statement_timeout: a slow read is QUERY_TIMEOUT, and pooled connections keep their default afterwards", async () => {
    const db = getDb();
    const before = await Promise.all(Array.from({ length: 3 }, () => sql<{ statement_timeout: string }>`show statement_timeout`.execute(db)));
    const failure = await refusal(withReadTimeout(db, 50, async (trx) => sql`select pg_sleep(1)`.execute(trx)));
    expect(failure).toMatchObject({ code: "QUERY_TIMEOUT", status: 503 });
    const inside = await withReadTimeout(db, 5_000, async (trx) => (await sql<{ statement_timeout: string }>`show statement_timeout`.execute(trx)).rows[0].statement_timeout);
    expect(inside).toBe("5s");
    const after = await Promise.all(Array.from({ length: 6 }, () => sql<{ statement_timeout: string }>`show statement_timeout`.execute(db)));
    expect(new Set(after.map((r) => r.rows[0].statement_timeout))).toEqual(new Set([before[0].rows[0].statement_timeout]));
  });

  it("writes: unknown and hidden fields are rejected, read-only ones refused, hidden values survive a PATCH, DELETE archives", async () => {
    const writer = await ctxFor(fx, fx.roles.writer);
    const count = async () => Number((await backend.query<{ n: number }>("select count(*)::int as n from content_entry_versions v join content_entries e on e.id = v.entry_id where e.content_model_id = $1", [fx.article.id]))[0].n);
    const before = await count();
    expect((await refusal(updateItem(writer, fx.article.apiKey, fx.articles[2], { secret: "overwrite" }))).code).toBe("UNKNOWN_FIELD");
    expect((await refusal(updateItem(writer, fx.article.apiKey, fx.articles[2], { ghost: 1 }))).code).toBe("UNKNOWN_FIELD");
    expect((await refusal(updateItem(writer, fx.article.apiKey, fx.articles[2], { title: "x" }))).code).toBe("FIELD_READ_ONLY");
    expect((await refusal(createItem(writer, fx.article.apiKey, { rating: 1 }))).code).toBe("REQUIRED_FIELD_NOT_WRITABLE");
    const editor = await ctxFor(fx, fx.roles.editor);
    expect((await refusal(createItem(editor, fx.article.apiKey, { title: "T", unknown_field: 1 }))).code).toBe("UNKNOWN_FIELD");
    expect(await count()).toBe(before);

    const patched = await updateItem(writer, fx.article.apiKey, fx.articles[2], { rating: 3 });
    expect(patched.item.data).not.toHaveProperty("secret");
    // The new draft does not take the live version away: the published read still serves rating 2.
    const live = await getItem(editor, fx.article.apiKey, fx.articles[2], P({}));
    expect(live.item).toMatchObject({ variant: "published", data: { rating: 2 } });
    const [stored] = await backend.query<{ data: Record<string, unknown> }>(
      "select v.data_jsonb as data from content_entries e join content_entry_versions v on v.id = e.current_draft_version_id where e.id = $1", [fx.articles[2]]);
    expect(stored.data).toMatchObject({ secret: `${SECRET}-2`, rating: 3, title: "Alpha 2" });

    const created = await createItem(editor, fx.article.apiKey, { title: "Made by API", rating: 2 });
    expect(created.item).toMatchObject({ variant: "draft", data: { title: "Made by API", rating: 2 } });
    await deleteItem(editor, fx.article.apiKey, created.item.id);
    const [archived] = await backend.query<{ status: string }>("select status from content_entries where id = $1", [created.item.id]);
    expect(archived.status).toBe("archived");
    expect((await refusal(deleteItem(editor, fx.article.apiKey, created.item.id))).code).toBe("ITEM_NOT_FOUND");
  });

  it("expansion into a model the token may not read is the bare id, the same shape as no expansion", async () => {
    const onlyArticles = await ctxFor(fx, fx.roles.editor, { allowedModels: [fx.article.apiKey] });
    const expanded = await listItems(onlyArticles, fx.article.apiKey, P({ expand: "author", sort: "rating", limit: "2" }));
    const plain = await listItems(onlyArticles, fx.article.apiKey, P({ sort: "rating", limit: "2" }));
    expect(expanded.items.map((item) => item.data.author)).toEqual(plain.items.map((item) => item.data.author));
    expect(typeof expanded.items[0].data.author).toBe("string");
  });

  it("scheduled publishing re-checks the publisher at run time", async () => {
    const releaseId = randomUUID();
    await backend.query("insert into releases (id, workspace_id, name, status) values ($1, $2, 'R', 'scheduled')", [releaseId, fx.workspaceId]);
    const [version] = await backend.query<{ id: string }>("select published_version_id as id from content_entries where id = $1", [fx.articles[3]]);
    await backend.query("insert into release_items (release_id, entry_id, entry_version_id) values ($1, $2, $3)", [releaseId, fx.articles[3], version.id]);
    expect(await scheduledPublishCheck(getDb(), fx.workspaceId, fx.adminUserId, releaseId)).toEqual({ ok: true });
    expect(await scheduledPublishCheck(getDb(), fx.workspaceId, null, releaseId)).toMatchObject({ ok: false, reason: "no_scheduler" });
    await backend.query("delete from role_permissions where role_id = $1 and permission_key = 'content.entry.publish'", [fx.roles.owner]);
    // The owner role still bypasses field rules but not the publish permission.
    expect(await scheduledPublishCheck(getDb(), fx.workspaceId, fx.adminUserId, releaseId)).toMatchObject({ ok: false, reason: "scheduler_cannot_publish" });
    await backend.query("insert into role_permissions (role_id, permission_key) values ($1, 'content.entry.publish')", [fx.roles.owner]);
    await backend.query("update workspace_members set status = 'suspended' where workspace_id = $1 and admin_user_id = $2", [fx.workspaceId, fx.adminUserId]);
    expect(await scheduledPublishCheck(getDb(), fx.workspaceId, fx.adminUserId, releaseId)).toMatchObject({ ok: false, reason: "scheduler_not_member" });
    await backend.query("update workspace_members set status = 'active' where workspace_id = $1 and admin_user_id = $2", [fx.workspaceId, fx.adminUserId]);
  });

  it("migration 0078: a token's role must be of its own workspace, and a role in use cannot be deleted", async () => {
    const other = await backend.createWorkspace();
    const [foreign] = await backend.query<{ id: string }>("insert into roles (workspace_id, key, name) values ($1, 'x', 'x') returning id", [other.workspaceId]);
    const insert = (roleId: string) => backend.query(
      "insert into developer_api_tokens (workspace_id, name, token_prefix, token_hash, role_id) values ($1, $2, 'pnv_x', $3, $4)", [fx.workspaceId, `t-${randomUUID()}`, randomUUID(), roleId]);
    await expect(insert(foreign.id)).rejects.toThrow();
    await insert(fx.roles.viewer);
    await expect(backend.query("delete from roles where id = $1", [fx.roles.viewer])).rejects.toThrow();
  });
});
