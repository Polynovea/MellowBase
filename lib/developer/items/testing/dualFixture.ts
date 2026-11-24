// Shared fixture for the items API database tests (items.dual and review.dual).
import { randomUUID } from "node:crypto";
import type { BackendFixtures } from "@/lib/db/testing/database";
import { getDb } from "@/lib/db/index";
import { uniqueKey } from "@/lib/schema/engine/testing";
import { createModel } from "@/lib/schema/modelService";
import { bringModelTableUp } from "@/lib/content/testing/tableMove";
import { indexEntry } from "@/lib/content/searchService";
import { getEntry, listEntryVersions } from "@/lib/content/entryService";
import type { DeveloperApiContext } from "@/lib/developer/apiAuth";
import type { FieldDefinition } from "@/lib/schema/fields/types";
import { ItemsApiError } from "@/lib/developer/items/errors";
import { principalForToken } from "@/lib/developer/items/principal";
import type { ItemsContext } from "@/lib/developer/items/service";

export const SECRET = `TOP-SECRET-${randomUUID().slice(0, 8)}`;
export const SALARY = 987654;
export const report = (label: string, value: unknown) => console.log(`[items-matrix] ${label} ${JSON.stringify(value)}`);
export const f = (key: string, type: FieldDefinition["type"], extra: Partial<FieldDefinition> = {}): FieldDefinition =>
  ({ key, label: key, type, required: false, localized: false, unique: false, ...extra } as FieldDefinition);

export interface Fixture {
  workspaceId: string;
  adminUserId: string;
  roles: Record<"owner" | "editor" | "writer" | "viewer" | "limited", string>;
  article: { id: string; apiKey: string };
  person: { id: string; apiKey: string };
  people: string[];
  articles: string[];
  draftOnly: string;
}

export async function insertEntries(backend: BackendFixtures, workspaceId: string, modelId: string, rows: Array<{ id: string; status: string; draft?: unknown; published?: unknown }>) {
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

export async function fixture(backend: BackendFixtures): Promise<Fixture> {
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

export const ALL_SCOPES = ["content.read", "content.write", "content.delete", "content.preview", "schema.read"];

export function apiCtx(fx: Fixture, roleId: string | null, over: Partial<DeveloperApiContext> = {}): DeveloperApiContext {
  return {
    requestId: "r", workspaceId: fx.workspaceId, tokenId: `token-${roleId ?? "none"}`, tokenName: "t", actorAdminUserId: fx.adminUserId,
    scopes: ALL_SCOPES, allowedModels: [], rateLimit: { limit: 100, remaining: 99, resetAt: "" }, agentIdentityId: null, agentToolName: null, roleId, ...over,
  };
}

export async function ctxFor(fx: Fixture, roleId: string | null, over: Partial<DeveloperApiContext> = {}, drafts: ItemsContext["drafts"] = { allowed: true, entryIds: null }): Promise<ItemsContext> {
  const api = apiCtx(fx, roleId, over);
  return { principal: await principalForToken(getDb(), api), callerId: api.tokenId, actorAdminUserId: fx.adminUserId, drafts };
}

export const P = (values: Record<string, string>) => new URLSearchParams(values);
export async function refusal(promise: Promise<unknown>) {
  try { await promise; } catch (error) { if (error instanceof ItemsApiError) return { code: error.code, status: error.status, details: error.details }; throw error; }
  throw new Error("expected a refusal");
}
export const strip = (r: { details?: unknown }) => ({ ...r, details: Object.keys((r.details ?? {}) as object).sort() });
