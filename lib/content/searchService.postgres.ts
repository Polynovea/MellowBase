// PostgreSQL implementation of content search (phase 1, wave 3).
//
// Ranking and filtering stay in cms_search_content_ranked (pg_trgm + full text, unchanged).
// Deliberate differences from the Supabase path it replaced in phase 1:
// - The saved-search list's "mine or shared" filter is bound parameters; the Supabase path built a
// PostgREST `or(owner_id.eq.<id>,is_shared.eq.true)` string from the owner ID.
// - Malformed IDs in search filters return no rows instead of a database error; a malformed saved
// search ID is "not found". Lists have explicit limits and tie-breaks.
import { sql } from "kysely";
import { callFunction, DEFAULT_LIST_LIMIT, expectOne, getDb, maybeOne } from "@/lib/db/index";
import { tableSource, type TableSource } from "@/lib/content/tableStore";
import { STORAGE_COLUMNS } from "@/lib/schema/engine/names";
import { trigramSchema } from "@/lib/schema/engine/render";
import type { ContentEntryRow, ContentEntryVersionRow } from "@/lib/content/entryService";
import { searchableText, type ContentSearchParams, type SearchFieldScope } from "@/lib/content/searchService";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (value: string) => UUID.test(value);

export async function indexEntry(entry: ContentEntryRow, version: ContentEntryVersionRow) {
  await getDb().insertInto("content_search_documents").values({
    entry_id: entry.id,
    workspace_id: entry.workspace_id,
    version_id: version.id,
    content_model_id: entry.content_model_id,
    locale: version.locale,
    status: entry.status,
    author_id: entry.created_by,
    search_text: searchableText(version.data_jsonb),
    updated_at: new Date().toISOString(),
  })
    // Same as the Supabase upsert on entry_id: every column it sent.
    .onConflict((conflict) => conflict.column("entry_id").doUpdateSet((eb) => ({
      workspace_id: eb.ref("excluded.workspace_id"), version_id: eb.ref("excluded.version_id"), content_model_id: eb.ref("excluded.content_model_id"),
      locale: eb.ref("excluded.locale"), status: eb.ref("excluded.status"), author_id: eb.ref("excluded.author_id"),
      search_text: eb.ref("excluded.search_text"), updated_at: eb.ref("excluded.updated_at"),
    })))
    .execute();
}

export async function searchContent(params: ContentSearchParams) {
  for (const id of [params.modelId, params.authorId, params.termId]) {
    if (id && !isUuid(id)) return [];
  }
  const scope = params.fieldScope;
  if (!scope) return unscopedSearch(params);
  const rows = scope.restricted.size ? await scopedSearch(params, scope) : await unscopedSearch(params);
  return readableSnippets(params.workspaceId, rows, scope);
}

/**
 * search_text is built from every string field of the version (and may hold text of fields deleted
 * since). With a field scope it is never returned as stored: each row's text is rebuilt from its
 * version's data restricted to the fields the caller can read, or is empty.
 */
async function readableSnippets<T extends { content_model_id: string | null; version_id?: string | null; search_text?: string | null }>(workspaceId: string, rows: T[], scope: SearchFieldScope): Promise<T[]> {
  const versionIds = [...new Set(rows.map((row) => row.version_id).filter((id): id is string => typeof id === "string" && isUuid(id)))];
  const versions = versionIds.length
    ? await getDb().selectFrom("content_entry_versions as v").innerJoin("content_entries as e", "e.id", "v.entry_id")
      .select(["v.id", "v.data_jsonb"]).where("e.workspace_id", "=", workspaceId).where("v.id", "in", versionIds).execute()
    : [];
  const dataById = new Map(versions.map((version) => [version.id, version.data_jsonb as unknown]));
  return rows.map((row) => {
    const readable = row.content_model_id ? scope.readable.get(row.content_model_id) : undefined;
    const data = row.version_id ? dataById.get(row.version_id) : undefined;
    if (!readable || !data || typeof data !== "object" || Array.isArray(data)) return { ...row, search_text: "" };
    const visible = Object.fromEntries(Object.entries(data as Record<string, unknown>).filter(([key]) => readable.has(key)));
    return { ...row, search_text: searchableText(visible) };
  });
}

/**
 * Search for a caller with hidden fields. Without a query nothing is matched or ranked, so only the
 * text is blanked. With one: unrestricted models keep the ranked search (one call per model, merged by
 * rank: exact for the requested window); restricted models match only on readable columns of their
 * table, unranked, after the ranked rows. A term that is only in a hidden field changes neither the
 * rows nor their order. A restricted model without a ready table is left out (fail closed).
 */
async function scopedSearch(params: ContentSearchParams, scope: SearchFieldScope) {
  const query = params.query?.trim() || null;
  if (!query) return unscopedSearch(params);
  const limit = Math.min(200, Math.max(1, params.limit ?? 50));
  const offset = Math.max(0, params.offset ?? 0);
  const models = params.modelId ? [params.modelId] : [...scope.readableModelIds];
  const window = { ...params, limit: Math.min(200, offset + limit), offset: 0 };
  const ranked: RankedRow[] = [];
  const unranked: RankedRow[] = [];
  for (const modelId of models) {
    const readable = scope.restricted.get(modelId);
    if (!readable) {
      ranked.push(...await unscopedSearch({ ...window, modelId, sort: "relevance" }));
      continue;
    }
    const source = await tableSource(params.workspaceId, modelId);
    if (source) unranked.push(...await searchModelTable({ ...window, modelId }, source, query, readable));
  }
  const byRank = (a: RankedRow, b: RankedRow) =>
    Math.max(Number(b.rank ?? 0), Number(b.similarity ?? 0)) - Math.max(Number(a.rank ?? 0), Number(a.similarity ?? 0))
    || new Date(b.updated_at ?? 0).getTime() - new Date(a.updated_at ?? 0).getTime();
  const byUpdated = (a: RankedRow, b: RankedRow) => new Date(b.updated_at ?? 0).getTime() - new Date(a.updated_at ?? 0).getTime();
  let rows = [...ranked.sort(byRank), ...unranked.sort(byUpdated)];
  if (params.sort === "updated_asc") rows = rows.sort((a, b) => -byUpdated(a, b));
  if (params.sort === "updated_desc") rows = rows.sort(byUpdated);
  return rows.slice(offset, offset + limit);
}

async function unscopedSearch(params: ContentSearchParams) {
  const query = params.query?.trim() || null;
  const source = params.modelId && query ? await tableSource(params.workspaceId, params.modelId) : null;
  const rows = source ? await searchModelTable(params, source, query!) : await callFunction("cms_search_content_ranked", {
    p_workspace_id: params.workspaceId,
    p_query: params.query?.trim() || null,
    p_model_id: params.modelId ?? null,
    p_status: params.status ?? null,
    p_locale: params.locale ?? null,
    p_author_id: params.authorId ?? null,
    p_updated_from: params.updatedFrom ?? null,
    p_updated_to: params.updatedTo ?? null,
    p_term_id: params.termId ?? null,
    p_limit: Math.min(200, Math.max(1, params.limit ?? 50)),
    p_offset: Math.max(0, params.offset ?? 0),
  });
  if (params.sort === "updated_asc") return [...rows].sort((a, b) => new Date(a.updated_at ?? 0).getTime() - new Date(b.updated_at ?? 0).getTime());
  if (params.sort === "updated_desc") return [...rows].sort((a, b) => new Date(b.updated_at ?? 0).getTime() - new Date(a.updated_at ?? 0).getTime());
  return rows;
}

type RankedRow = Awaited<ReturnType<typeof callFunction<"cms_search_content_ranked">>>[number];

/**
 * Phase 3, model-scoped search on a model switched to its table. Same filters, ranking and order as
 * cms_search_content_ranked (ranking stays on content_search_documents, which every save still
 * maintains); only the trigram and substring match moves to the model table's search-indexed text
 * columns (pg_trgm GIN indexes the schema engine builds). The full-text match stays on the document.
 * Known difference from the whole-document match: a phrase spanning two fields, and text inside
 * non-text fields (rich text, lists, JSON) or in text fields that are not search-indexed (slug, email,
 * url, select), match only through full text, not by trigram or substring.
 */
let trgmSchemaLookup: Promise<string | null> | null = null;

/** The schema pg_trgm is installed in (looked up once), so its operator and functions are named exactly. */
function trgmSchema(): Promise<string | null> {
  trgmSchemaLookup ??= trigramSchema(getDb())
    .then((schema) => (schema && /^[a-z_][a-z0-9_]{0,62}$/.test(schema) ? schema : null))
    .catch(() => { trgmSchemaLookup = null; return null; });
  return trgmSchemaLookup;
}

/** A substring pattern for ILIKE: the query's own % and _ (and the escape character) match literally. */
export const likeSubstring = (q: string) => `%${q.replace(/[\\%_]/g, "\\$&")}%`;

/**
 * `readable`: for a caller with hidden fields, only these fields' columns match, and neither the
 * whole-document full-text match nor its ranking is used (rank and similarity are 0).
 */
async function searchModelTable(params: ContentSearchParams, source: TableSource, q: string, readable?: ReadonlySet<string>): Promise<RankedRow[]> {
  const columns = Object.values(source.shape.columns).filter((column) => column.searchIndexed && column.pgType === "text" && (!readable || readable.has(column.field)));
  const table = sql.id("content", source.table);
  const entryCol = sql.id(STORAGE_COLUMNS.entryId);
  const variantCol = sql.id(STORAGE_COLUMNS.variant);
  const localeCol = sql.id(STORAGE_COLUMNS.locale);
  // pg_trgm's % operator and similarity(), schema-qualified (never left to the session's search_path).
  const schema = await trgmSchema();
  const similar = (text: unknown) => (schema ? sql`${sql.id(schema)}.similarity(${text}, input.q)` : sql`0::real`);
  const pattern = likeSubstring(q);
  const columnMatch = columns.length
    ? sql.join(columns.map((column) => {
      const col = sql`r.${sql.id(column.name)}`;
      return schema ? sql`${col} operator(${sql.id(schema)}.%) ${q} or ${col} ilike ${pattern}` : sql`${col} ilike ${pattern}`;
    }), sql` or `)
    : sql`false`;
  const limit = Math.min(200, Math.max(1, params.limit ?? 50));
  const offset = Math.max(0, params.offset ?? 0);
  const { rows } = await sql<RankedRow>`
    with input as (select ${q}::text as q, websearch_to_tsquery('simple', ${q}) as tsq)
    select d.entry_id, d.workspace_id, d.version_id, d.content_model_id, d.locale, d.status, d.author_id, d.search_text, d.updated_at,
           ${readable ? sql`0::real` : sql`ts_rank_cd(d.search_vector, input.tsq)::real`} as rank,
           ${readable ? sql`0::real` : similar(sql`d.search_text`)}::real as similarity
      from public.content_search_documents d
     cross join input
     where d.workspace_id = ${params.workspaceId}
       and d.content_model_id = ${source.modelId}
       ${params.status ? sql`and d.status = ${params.status}` : sql``}
       ${params.locale ? sql`and d.locale = ${params.locale}` : sql``}
       ${params.authorId ? sql`and d.author_id = ${params.authorId}::uuid` : sql``}
       ${params.updatedFrom ? sql`and d.updated_at >= ${params.updatedFrom}::timestamptz` : sql``}
       ${params.updatedTo ? sql`and d.updated_at <= ${params.updatedTo}::timestamptz` : sql``}
       ${params.termId ? sql`and exists (select 1 from public.content_relations rel
                                          where rel.workspace_id = ${params.workspaceId} and rel.source_entry_id = d.entry_id
                                            and rel.source_version_id = d.version_id and rel.target_term_id = ${params.termId}::uuid)` : sql``}
       and (
         ${readable ? sql`false` : sql`d.search_vector @@ input.tsq`}
         -- The table row of this document's own version: same entry, the variant whose pointer is the
         -- document's version, same locale. A draft's text never surfaces through its published
         -- document, nor one locale's through another's.
         or exists (
           select 1 from ${table} r
             join public.content_entries e on e.id = r.${entryCol} and e.workspace_id = d.workspace_id and e.content_model_id = d.content_model_id
            where r.${entryCol} = d.entry_id
              and r.${localeCol} is not distinct from d.locale
              and ((r.${variantCol} = 'draft' and e.current_draft_version_id = d.version_id)
                or (r.${variantCol} = 'published' and e.published_version_id = d.version_id))
              and (${columnMatch}))
       )
     order by ${readable ? sql`d.updated_at desc` : sql`greatest(ts_rank_cd(d.search_vector, input.tsq), ${similar(sql`d.search_text`)}) desc, d.updated_at desc`}
     limit ${limit} offset ${offset}`.execute(getDb());
  return rows;
}

export async function listSavedSearches(workspaceId: string, ownerId: string) {
  return getDb().selectFrom("content_saved_searches").selectAll()
    .where("workspace_id", "=", workspaceId)
    .where((eb) => eb.or([eb("owner_id", "=", ownerId), eb("is_shared", "=", true)]))
    .orderBy("updated_at", "desc").orderBy("id", "desc").limit(DEFAULT_LIST_LIMIT).execute();
}

export async function saveSearch(params: { workspaceId: string; ownerId: string; name: string; query: Record<string, unknown>; shared?: boolean }) {
  if (!params.name.trim()) throw new Error("Saved search name is required");
  return expectOne(await getDb().insertInto("content_saved_searches").values({
    workspace_id: params.workspaceId,
    owner_id: params.ownerId,
    name: params.name.trim(),
    query_json: JSON.stringify(params.query),
    is_shared: Boolean(params.shared),
    updated_at: new Date().toISOString(),
  })
    // Same as the Supabase upsert on (workspace_id, owner_id, name): every column it sent.
    .onConflict((conflict) => conflict.columns(["workspace_id", "owner_id", "name"]).doUpdateSet((eb) => ({
      query_json: eb.ref("excluded.query_json"), is_shared: eb.ref("excluded.is_shared"), updated_at: eb.ref("excluded.updated_at"),
    })))
    .returningAll().execute(), "Could not save search");
}

export async function deleteSavedSearch(params: { workspaceId: string; ownerId: string; id: string }) {
  const row = isUuid(params.id)
    ? maybeOne(await getDb().deleteFrom("content_saved_searches")
      .where("workspace_id", "=", params.workspaceId).where("owner_id", "=", params.ownerId).where("id", "=", params.id)
      .returning("id").execute())
    : null;
  if (!row) throw new Error("Saved search not found or not owned by this actor");
  return row;
}
