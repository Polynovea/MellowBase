/**
 * The items API service: list / get / create / update / delete for one model, for one principal.
 *
 * Per request: load the model and the models its relations reach (always the same set, whatever the
 * request asks, so a hidden field costs no extra query), resolve access for all of them in one go
 * (resolveModelAccesses → decideModelAccess), parse every parameter through that access, run the read
 * in its own transaction with a transaction-local statement_timeout, sanitise every item (and every
 * expanded item) with the target model's own access, and sign the next cursor for this caller.
 * Writes go through entryService (versions, table sync, search, audit, webhooks) after sanitise "in".
 */
import { sql, type Kysely } from "kysely";
import type { DB } from "@/lib/db/generated/database";
import { getDb } from "@/lib/db/index";
import { tableSources } from "@/lib/content/tableStore";
import { archiveEntry, createEntry, getEntry, saveDraft } from "@/lib/content/entryService";
import type { CanonicalSchema, FieldType } from "@/lib/schema/fields/types";
import { loadModelRefs } from "@/lib/developer/items/models";
import { lookupFor, resolveModelAccesses, sanitise, type ModelAccess, type ModelRef, type Principal } from "@/lib/developer/items/access";
import { decodeCursor, encodeCursor, sortSpecHash } from "@/lib/developer/items/cursor";
import { ItemsApiError } from "@/lib/developer/items/errors";
import { checkJoins, parseExpand, parseFields, parseFilter, parseSort, type ExpandNode, type FieldLookup, type ResolvedField } from "@/lib/developer/items/filter";
import { DEFAULT_SORT, runItemsQuery, type ItemRow, type QueryModel, type SortSpec } from "@/lib/developer/items/query";
import { SEARCHABLE_TYPES, SEARCH_TERM, type ItemRecord, type Variant } from "@/lib/developer/items/types";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOCALE = /^[A-Za-z0-9_-]{1,35}$/;
/** Relation hops loaded around the requested model (filter: 1, expand: 2). */
const RELATION_DEPTH = 2;
const MAX_MODELS = 25;

export interface ItemsContext {
  principal: Principal;
  /** Who cursors are bound to (token id, or principal id). */
  callerId: string;
  /** Admin user recorded on writes (the token's creator). */
  actorAdminUserId: string | null;
  /** Draft reads: allowed at all, and limited to these entries (entry/release preview tokens) or not (null). */
  drafts: { allowed: boolean; entryIds: readonly string[] | null };
  db?: Kysely<DB>;
}

interface Loaded {
  root: ModelRef;
  models: Map<string, ModelRef>;
  queryModels: Map<string, QueryModel>;
  accesses: Map<string, ModelAccess>;
  lookup: FieldLookup;
}

/** The model and every model its relations reach within RELATION_DEPTH hops, resolved for the principal. */
async function load(ctx: ItemsContext, apiKey: string): Promise<Loaded> {
  const db = ctx.db ?? getDb();
  const workspaceId = ctx.principal.workspaceId;
  const [root] = await loadModelRefs(db, workspaceId, [apiKey]);
  if (!root) throw new ItemsApiError("MODEL_NOT_FOUND", "Content model not found");
  const models = new Map<string, ModelRef>([[root.apiKey, root]]);
  let frontier = [root];
  for (let depth = 0; depth < RELATION_DEPTH && frontier.length; depth += 1) {
    const wanted = [...new Set(frontier.flatMap((model) => model.schema.fields.flatMap((field) => (field.type === "relation" && field.relation ? [field.relation.targetModelApiKey] : []))))]
      .filter((key) => !models.has(key)).slice(0, MAX_MODELS - models.size);
    frontier = await loadModelRefs(db, workspaceId, wanted);
    for (const model of frontier) models.set(model.apiKey, model);
  }
  const [accesses, sources] = await Promise.all([
    resolveModelAccesses(ctx.principal, [...models.values()], db),
    tableSources(workspaceId, [...models.values()].map((model) => model.id), db),
  ]);
  const queryModels = new Map([...models.values()].map((model) => [model.apiKey, { id: model.id, apiKey: model.apiKey, source: sources.get(model.id) ?? null }]));
  return { root, models, queryModels, accesses, lookup: lookupFor(accesses.values()) };
}

function rootAccess(loaded: Loaded): ModelAccess {
  const access = loaded.accesses.get(loaded.root.apiKey)!;
  if (!access.canRead) throw new ItemsApiError("MODEL_RESTRICTED", "Token is not permitted to access this content model");
  return access;
}

function variantOf(ctx: ItemsContext, raw: string | null): Variant {
  const variant = raw ?? "published";
  if (variant !== "published" && variant !== "draft") throw new ItemsApiError("INVALID_PARAMETER", "variant is published or draft");
  if (variant === "draft" && !ctx.drafts.allowed) throw new ItemsApiError("PREVIEW_TOKEN_REQUIRED", "Drafts need a valid preview token");
  return variant;
}

function localeOf(raw: string | null): string | undefined {
  if (raw === null || raw === "") return undefined;
  if (!LOCALE.test(raw)) throw new ItemsApiError("INVALID_PARAMETER", "Invalid locale");
  return raw;
}

/** Runs `fn` in a read transaction whose statement_timeout is the principal's limit (transaction-local). */
export async function withReadTimeout<T>(db: Kysely<DB>, timeoutMs: number, fn: (trx: Kysely<DB>) => Promise<T>): Promise<T> {
  try {
    return await db.transaction().execute(async (trx) => {
      await sql`select set_config('statement_timeout', ${String(Math.max(1, Math.floor(timeoutMs)))}, true)`.execute(trx);
      return fn(trx);
    });
  } catch (error) {
    if ((error as { code?: unknown })?.code === "57014") throw new ItemsApiError("QUERY_TIMEOUT", "The query took too long. Narrow the filter or page size and try again.");
    throw error;
  }
}

function toRecord(row: ItemRow, access: ModelAccess, fields: Set<string> | null): ItemRecord {
  let data = sanitise(access, row.data, "out");
  if (fields) data = Object.fromEntries(Object.entries(data).filter(([key]) => fields.has(key)));
  return { id: row.entryId, locale: row.locale, variant: row.variant, version: row.version, createdAt: row.createdAt, updatedAt: row.updatedAt, publishedAt: row.publishedAt, data };
}

/**
 * Replaces relation ids with the related items, level by level. A target the caller may not read, a
 * target outside the caller's preview scope, or one that is not visible in this variant stays a bare id:
 * exactly what the caller gets without expansion, so expansion reveals nothing about the target.
 */
async function expandItems(trx: Kysely<DB>, ctx: ItemsContext, loaded: Loaded, items: ItemRecord[], tree: ExpandNode[], variant: Variant): Promise<void> {
  for (const node of tree) {
    const access = loaded.accesses.get(node.target);
    const model = loaded.queryModels.get(node.target);
    if (!access?.canRead || !model) continue;
    const key = node.field.key;
    const ids = new Set<string>();
    for (const item of items) {
      const value = item.data[key];
      for (const id of Array.isArray(value) ? value : [value]) if (typeof id === "string" && UUID.test(id)) ids.add(id);
    }
    let wanted = [...ids].slice(0, 500);
    if (variant === "draft" && ctx.drafts.entryIds) wanted = wanted.filter((id) => ctx.drafts.entryIds!.includes(id));
    if (!wanted.length) continue;
    const rows = await runItemsQuery(trx, {
      workspaceId: ctx.principal.workspaceId, model, variant, entryIds: wanted, sort: [], limit: Math.min(1_000, wanted.length * 20),
    });
    const related = rows.map((row) => toRecord(row, access, null));
    if (node.children.length) await expandItems(trx, ctx, loaded, related, node.children, variant);
    for (const item of items) {
      const pick = (id: unknown) => {
        if (typeof id !== "string") return id;
        const candidates = related.filter((r) => r.id === id);
        return candidates.find((r) => r.locale === item.locale) ?? candidates[0] ?? id;
      };
      const value = item.data[key];
      if (value === undefined) continue;
      item.data[key] = Array.isArray(value) ? value.map(pick) : pick(value);
    }
  }
}

export interface ListResult {
  items: ItemRecord[];
  nextCursor: string | null;
  limit: number;
  schemaHash: string;
}

/** GET /items. `params` are the request's query parameters. */
export async function listItems(ctx: ItemsContext, apiKey: string, params: URLSearchParams): Promise<ListResult> {
  const db = ctx.db ?? getDb();
  const loaded = await load(ctx, apiKey);
  const access = rootAccess(loaded);
  const limits = access.limits;
  const variant = variantOf(ctx, params.get("variant"));
  const locale = localeOf(params.get("locale"));

  const limitRaw = params.get("limit");
  const limit = limitRaw === null ? limits.defaultPageSize : Number(limitRaw);
  if (!Number.isInteger(limit) || limit < 1) throw new ItemsApiError("INVALID_PARAMETER", "limit is a positive integer");
  if (limit > limits.pageSize) throw new ItemsApiError("PAGE_TOO_LARGE", `limit is at most ${limits.pageSize}`);

  const filter = parseFilter(params.get("filter"), apiKey, loaded.lookup, limits);
  const parsedSort = parseSort(params.get("sort"), apiKey, loaded.lookup, limits);
  const sort: SortSpec[] = parsedSort.length ? parsedSort : DEFAULT_SORT.map((key) => ({ ...key, resolved: loaded.lookup.field(apiKey, key.field)! }));
  const expand = parseExpand(params.get("expand"), apiKey, loaded.lookup, limits);
  checkJoins(limits, filter.joins, expand.joins);
  const fields = parseFields(params.get("fields"), apiKey, loaded.lookup);

  const searchRaw = params.get("search");
  let search: { term: string; fields: ResolvedField[] } | null = null;
  if (searchRaw !== null && searchRaw !== "") {
    const term = searchRaw.trim();
    if (term.length < SEARCH_TERM.min || term.length > SEARCH_TERM.max) throw new ItemsApiError("INVALID_PARAMETER", `search is ${SEARCH_TERM.min}-${SEARCH_TERM.max} characters`);
    // Only fields this caller can read: a term that is only in a hidden field matches nothing.
    search = { term, fields: [...access.fields.values()].filter((field) => !field.system && SEARCHABLE_TYPES.has(field.type as FieldType)) };
  }

  const specHash = sortSpecHash(apiKey, variant, sort);
  const cursorRaw = params.get("cursor");
  const after = cursorRaw ? decodeCursor(cursorRaw, ctx.callerId, { specHash, sort }) : null;

  const rows = await withReadTimeout(db, limits.statementTimeoutMs, async (trx) => {
    const found = await runItemsQuery(trx, {
      workspaceId: ctx.principal.workspaceId,
      model: loaded.queryModels.get(apiKey)!,
      variant,
      locale,
      entryIds: variant === "draft" ? ctx.drafts.entryIds ?? undefined : undefined,
      filter: filter.filter,
      relationModels: loaded.queryModels,
      sort,
      search,
      after,
      limit: limit + 1,
    });
    const page = found.slice(0, limit);
    const items = page.map((row) => toRecord(row, access, fields));
    if (expand.tree.length) await expandItems(trx, ctx, loaded, items, expand.tree, variant);
    return { found, page, items };
  });

  const last = rows.page[rows.page.length - 1];
  const nextCursor = rows.found.length > limit && last
    ? encodeCursor({ s: specHash, k: last.sortValues, id: last.entryId, l: last.locale }, ctx.callerId)
    : null;
  return { items: rows.items, nextCursor, limit, schemaHash: loaded.root.schemaHash };
}

/** GET /items/{id}: one entry (its row for `locale`, or its first locale). */
export async function getItem(ctx: ItemsContext, apiKey: string, id: string, params: URLSearchParams): Promise<{ item: ItemRecord; schemaHash: string }> {
  const db = ctx.db ?? getDb();
  const loaded = await load(ctx, apiKey);
  const access = rootAccess(loaded);
  const variant = variantOf(ctx, params.get("variant"));
  const locale = localeOf(params.get("locale"));
  if (!UUID.test(id)) throw new ItemsApiError("ITEM_NOT_FOUND", "Item not found");
  if (variant === "draft" && ctx.drafts.entryIds && !ctx.drafts.entryIds.includes(id)) throw new ItemsApiError("ITEM_NOT_FOUND", "Item not found");
  const expand = parseExpand(params.get("expand"), apiKey, loaded.lookup, access.limits);
  checkJoins(access.limits, expand.joins);
  const fields = parseFields(params.get("fields"), apiKey, loaded.lookup);
  const item = await withReadTimeout(db, access.limits.statementTimeoutMs, async (trx) => {
    const rows = await runItemsQuery(trx, { workspaceId: ctx.principal.workspaceId, model: loaded.queryModels.get(apiKey)!, variant, locale, entryIds: [id], sort: [], limit: 50 });
    if (!rows.length) return null;
    const record = toRecord(rows[0], access, fields);
    if (expand.tree.length) await expandItems(trx, ctx, loaded, [record], expand.tree, variant);
    return record;
  });
  if (!item) throw new ItemsApiError("ITEM_NOT_FOUND", "Item not found");
  return { item, schemaHash: loaded.root.schemaHash };
}

function writeAccess(loaded: Loaded, need: "write" | "delete"): ModelAccess {
  const access = rootAccess(loaded);
  if (need === "write" ? !access.canWrite : !access.canDelete) throw new ItemsApiError("INSUFFICIENT_SCOPE", need === "write" ? "This token cannot change items of this model" : "This token cannot delete items of this model");
  return access;
}

function requireActor(ctx: ItemsContext): string {
  if (!ctx.actorAdminUserId) throw new ItemsApiError("INSUFFICIENT_SCOPE", "This token no longer has an active creator identity for audited changes");
  return ctx.actorAdminUserId;
}

/** entryService's messages may name fields; for a caller with hidden fields they are replaced. */
function writeError(access: ModelAccess, result: { error: string; status: number }): ItemsApiError {
  if (result.status === 404) return new ItemsApiError("ITEM_NOT_FOUND", "Item not found");
  const message = access.restricted ? "The item is not valid for this model" : result.error;
  return new ItemsApiError("VALIDATION_FAILED", message);
}

const writeCtx = (ctx: ItemsContext): ItemsContext => ({ ...ctx, drafts: { allowed: true, entryIds: null } });

/** POST /items: a new draft entry. Required fields the caller cannot write are refused up front. */
export async function createItem(ctx: ItemsContext, apiKey: string, body: unknown, locale?: string): Promise<{ item: ItemRecord; schemaHash: string }> {
  const loaded = await load(ctx, apiKey);
  const access = writeAccess(loaded, "write");
  const actor = requireActor(ctx);
  const data = sanitise(access, body, "in");
  const blocked = loaded.root.schema.fields.filter((field) => field.required && !access.writable.has(field.key));
  if (blocked.length) {
    const named = blocked.filter((field) => access.readable.has(field.key)).map((field) => field.key);
    throw new ItemsApiError("REQUIRED_FIELD_NOT_WRITABLE", named.length === blocked.length ? `Required fields you cannot set: ${named.join(", ")}` : "This model requires fields this token cannot set", named.length === blocked.length ? { fields: named } : undefined);
  }
  const result = await createEntry({ workspaceId: ctx.principal.workspaceId, modelId: loaded.root.id, data, locale: localeOf(locale ?? null), actorAdminUserId: actor, changeSummary: "Created through the items API" });
  if (!result.ok) throw writeError(access, result);
  return getItem(writeCtx(ctx), apiKey, result.data.entry.id, new URLSearchParams({ variant: "draft" }));
}

/**
 * PATCH /items/{id}: a new draft version = the current content with the given fields replaced. Fields
 * the caller cannot read are carried over untouched (they are never sent back, never dropped).
 */
export async function updateItem(ctx: ItemsContext, apiKey: string, id: string, body: unknown): Promise<{ item: ItemRecord; schemaHash: string }> {
  const db = ctx.db ?? getDb();
  const loaded = await load(ctx, apiKey);
  const access = writeAccess(loaded, "write");
  const actor = requireActor(ctx);
  const changes = sanitise(access, body, "in");
  if (!Object.keys(changes).length) throw new ItemsApiError("VALIDATION_FAILED", "Send at least one field to change");
  if (!UUID.test(id)) throw new ItemsApiError("ITEM_NOT_FOUND", "Item not found");
  const entry = await getEntry(ctx.principal.workspaceId, id);
  if (!entry || entry.content_model_id !== loaded.root.id) throw new ItemsApiError("ITEM_NOT_FOUND", "Item not found");
  const pointer = entry.current_draft_version_id ?? entry.published_version_id;
  const current = pointer
    ? await db.selectFrom("content_entry_versions").select(["data_jsonb", "version_number", "locale"]).where("id", "=", pointer).where("entry_id", "=", entry.id).executeTakeFirst()
    : undefined;
  const latest = await db.selectFrom("content_entry_versions").select("version_number").where("entry_id", "=", entry.id).orderBy("version_number", "desc").limit(1).executeTakeFirst();
  const base = current?.data_jsonb && typeof current.data_jsonb === "object" && !Array.isArray(current.data_jsonb) ? current.data_jsonb as Record<string, unknown> : {};
  const result = await saveDraft({
    workspaceId: ctx.principal.workspaceId, entryId: entry.id, data: { ...base, ...changes }, locale: current?.locale,
    actorAdminUserId: actor, changeSummary: "Updated through the items API", expectedVersionNumber: latest?.version_number ?? 0,
  });
  if (!result.ok) {
    if (result.status === 409) throw new ItemsApiError("VALIDATION_FAILED", "The item changed while you were updating it; read it again and retry");
    throw writeError(access, result);
  }
  return getItem(writeCtx(ctx), apiKey, entry.id, new URLSearchParams({ variant: "draft" }));
}

/** DELETE /items/{id}: archives the entry (recoverable from the CMS), the CMS's delete. */
export async function deleteItem(ctx: ItemsContext, apiKey: string, id: string): Promise<void> {
  const loaded = await load(ctx, apiKey);
  const access = writeAccess(loaded, "delete");
  const actor = requireActor(ctx);
  if (!UUID.test(id)) throw new ItemsApiError("ITEM_NOT_FOUND", "Item not found");
  const entry = await getEntry(ctx.principal.workspaceId, id);
  if (!entry || entry.content_model_id !== loaded.root.id || entry.status === "archived") throw new ItemsApiError("ITEM_NOT_FOUND", "Item not found");
  const result = await archiveEntry({ workspaceId: ctx.principal.workspaceId, entryId: entry.id, actorAdminUserId: actor });
  if (!result.ok) throw writeError(access, result);
}

/** For the OpenAPI route: every active model, resolved for the principal. */
export async function accessibleModels(ctx: ItemsContext): Promise<Array<{ model: ModelRef; access: ModelAccess; name: string }>> {
  const db = ctx.db ?? getDb();
  const rows = await db.selectFrom("content_models").select(["api_key", "name"]).where("workspace_id", "=", ctx.principal.workspaceId).where("status", "=", "active").orderBy("api_key").limit(500).execute();
  const models = await loadModelRefs(db, ctx.principal.workspaceId, rows.map((row) => row.api_key));
  const accesses = await resolveModelAccesses(ctx.principal, models, db);
  const names = new Map(rows.map((row) => [row.api_key, row.name]));
  return models.map((model) => ({ model, access: accesses.get(model.apiKey)!, name: names.get(model.apiKey) ?? model.apiKey })).filter((entry) => entry.access.canRead);
}
