// Direct PostgreSQL path of the workspace export reads (phase 1, wave 2). Same results as
// exportData.supabase.ts, without PostgREST's 1000-row cap. Table and column names come from the
// export's own constants; they are still checked against a plain-identifier pattern and always
// quoted, never concatenated.
import { sql } from "kysely";
import { getDb, maybeOne } from "@/lib/db/index";

const IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/;

function identifier(name: string): string {
  if (!IDENTIFIER.test(name)) throw new Error(`Export refused an unexpected identifier: ${JSON.stringify(name)}`);
  return name;
}

function columns(select: string) {
  if (select.trim() === "*") return sql`*`;
  return sql.join(select.split(",").map((column) => sql.ref(identifier(column.trim()))));
}

/* eslint-disable @typescript-eslint/no-explicit-any -- export rows are passed through as they are */
export async function rowsForWorkspace(table: string, workspaceId: string, select = "*"): Promise<any[]> {
  try {
    const { rows } = await sql`select ${columns(select)} from ${sql.table(identifier(table))} where workspace_id = ${workspaceId}`.execute(getDb());
    return rows as any[];
  } catch (error) {
    throw Object.assign(new Error(`Export failed for ${table}`), { cause: error });
  }
}

export async function rowsByIds(table: string, column: string, ids: string[], select = "*"): Promise<any[]> {
  if (!ids.length) return [];
  try {
    const { rows } = await sql`select ${columns(select)} from ${sql.table(identifier(table))} where ${sql.ref(identifier(column))} = any(${ids}::uuid[])`.execute(getDb());
    return rows as any[];
  } catch (error) {
    throw Object.assign(new Error(`Export failed for ${table}`), { cause: error });
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export async function exportedWorkspace(workspaceId: string): Promise<{ id: string; slug: string; name: string; created_at: string | null; updated_at: string | null } | null> {
  return maybeOne(await getDb().selectFrom("workspaces").select(["id", "slug", "name", "created_at", "updated_at"]).where("id", "=", workspaceId).execute());
}
