// PostgreSQL implementation of the legacy marketing tables adapter (blog posts, live metrics,
// social posts, ad campaigns; phase 1, wave 5). Deliberate differences from the Supabase path it
// replaced in phase 1:
// - Writes take only the table's editable columns. A body with any other key (including id and
// created_at) is refused with a message naming it; PostgREST passed every key through.
// - Saving the live metrics replaces them in one transaction. The Supabase path deleted every metric
// and then inserted, so a failed insert lost them all.
// - Malformed ids find nothing instead of failing on the cast; database text never reaches the caller.
import { sql } from "kysely";
import { DEFAULT_LIST_LIMIT, getDb, withTransaction } from "@/lib/db/index";
import { clientErrorMessage } from "@/lib/http/clientError";

// Supabase path of the legacy marketing tables adapter (moved unchanged from lib/dbAdapter.ts;
// deleted with the switch at the end of phase 1).
export type TableName = "blog_posts" | "live_metrics" | "social_posts" | "ad_campaigns";


/* eslint-disable @typescript-eslint/no-explicit-any -- legacy rows are passed through as the routes read them */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EDITABLE: Record<TableName, readonly string[]> = {
  blog_posts: ["title", "slug", "content", "excerpt", "author", "status", "published_at", "updated_at"],
  live_metrics: ["label", "value", "period", "trend", "trend_direction"],
  social_posts: ["entity", "venue_id", "title", "platform", "type", "posted", "views", "status", "checkpoints", "updated_at"],
  ad_campaigns: ["entity", "venue_id", "campaign", "platform", "objective", "budget", "spend", "ctr", "conversions", "status", "updated_at"],
};
const FIELDS: Record<TableName, readonly string[]> = {
  blog_posts: ["id", "slug", ...EDITABLE.blog_posts],
  live_metrics: ["id", ...EDITABLE.live_metrics],
  social_posts: ["id", ...EDITABLE.social_posts],
  ad_campaigns: ["id", ...EDITABLE.ad_campaigns],
};
const ORDER: Record<TableName, string> = { blog_posts: "published_at", live_metrics: "id", social_posts: "id", ad_campaigns: "id" };

function validId(table: TableName, id: string | number): boolean {
  return table === "live_metrics" ? /^\d{1,9}$/.test(String(id)) : UUID.test(String(id));
}

/** The body's columns, or the first key the table does not let callers write. */
function columns(table: TableName, item: unknown, allowId = false): { values: Record<string, unknown> } | { error: string } {
  if (!item || typeof item !== "object" || Array.isArray(item)) return { error: "Request body must be a JSON object" };
  const allowed = allowId ? ["id", ...EDITABLE[table]] : EDITABLE[table];
  const values: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(item as Record<string, unknown>)) {
    if (value === undefined) continue;
    if (!allowed.includes(key)) return { error: `Field ${key} cannot be written` };
    values[key] = value;
  }
  return { values };
}

const failure = (error: unknown, fallback: string) => clientErrorMessage(error, fallback);

export async function getDbItems(table: TableName): Promise<{ data: any[]; error: any }> {
  try {
    const data = await getDb().selectFrom(table as any).selectAll().orderBy(sql.ref(ORDER[table]), "desc").orderBy("id" as any).limit(DEFAULT_LIST_LIMIT).execute();
    return { data, error: null };
  } catch (error) {
    return { data: [], error: failure(error, "Could not read items") };
  }
}

export async function insertDbItem(table: TableName, item: any): Promise<{ data: any; error: any }> {
  const parsed = columns(table, item);
  if ("error" in parsed) return { data: null, error: parsed.error };
  try {
    return { data: await getDb().insertInto(table as any).values(parsed.values as any).returningAll().executeTakeFirstOrThrow(), error: null };
  } catch (error) {
    return { data: null, error: failure(error, "Could not create item") };
  }
}

export async function updateDbItem(table: TableName, id: string | number, item: any): Promise<{ data: any; error: any }> {
  const parsed = columns(table, item);
  if ("error" in parsed) return { data: null, error: parsed.error };
  if (!validId(table, id)) return { data: null, error: "Not found" };
  if (!Object.keys(parsed.values).length) return { data: null, error: "Nothing to update" };
  try {
    const data = await getDb().updateTable(table as any).set(parsed.values as any).where("id" as any, "=", id).returningAll().executeTakeFirst();
    return data ? { data, error: null } : { data: null, error: "Not found" };
  } catch (error) {
    return { data: null, error: failure(error, "Could not update item") };
  }
}

export async function getDbItem(table: TableName, id: string | number): Promise<{ data: any; error: any }> {
  if (!validId(table, id)) return { data: null, error: null };
  try {
    return { data: (await getDb().selectFrom(table as any).selectAll().where("id" as any, "=", id).executeTakeFirst()) ?? null, error: null };
  } catch (error) {
    return { data: null, error: failure(error, "Could not read item") };
  }
}

export async function getDbItemByField(table: TableName, field: string, value: string): Promise<{ data: any; error: any }> {
  if (!FIELDS[table].includes(field) || field === "id") return { data: null, error: `Field ${field} cannot be searched` };
  try {
    const rows = await getDb().selectFrom(table as any).selectAll().where(sql.ref(field), "=", value).orderBy("id" as any).limit(2).execute();
    if (rows.length > 1) return { data: null, error: "More than one item matches" };
    return { data: rows[0] ?? null, error: null };
  } catch (error) {
    return { data: null, error: failure(error, "Could not read item") };
  }
}

export async function deleteDbItem(table: TableName, id: string | number): Promise<{ success: boolean; error: any }> {
  if (!validId(table, id)) return { success: true, error: null };
  try {
    await getDb().deleteFrom(table as any).where("id" as any, "=", id).execute();
    return { success: true, error: null };
  } catch (error) {
    return { success: false, error: failure(error, "Could not delete item") };
  }
}

export async function bulkUpsertMetrics(body: any[]): Promise<{ data: any[] | null; error: any }> {
  if (!Array.isArray(body)) return { data: null, error: "Request body must be a list of metrics" };
  const rows: Array<Record<string, unknown>> = [];
  for (const item of body) {
    const parsed = columns("live_metrics", item, true);
    if ("error" in parsed) return { data: null, error: parsed.error };
    if (parsed.values.id != null && !validId("live_metrics", parsed.values.id as string | number)) return { data: null, error: "Metric ids must be whole numbers" };
    if (parsed.values.id == null) delete parsed.values.id;
    rows.push(parsed.values);
  }
  try {
    const data = await withTransaction(async (trx) => {
      await trx.deleteFrom("live_metrics").where("id", "<>", 0).execute();
      const withId = rows.filter((row) => row.id != null);
      const withoutId = rows.filter((row) => row.id == null);
      const results: any[] = [];
      // Inserted separately: one batch mixing the two would send NULL for the id-less rows' id.
      if (withId.length) results.push(...await trx.insertInto("live_metrics").values(withId as any).returningAll().execute());
      if (withoutId.length) results.push(...await trx.insertInto("live_metrics").values(withoutId as any).returningAll().execute());
      return results;
    });
    return { data, error: null };
  } catch (error) {
    return { data: null, error: failure(error, "Could not save metrics") };
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */
