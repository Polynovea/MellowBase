// Loads models (current version, schema, hash) for the items API and its side channels. Kept small so
// the delivery worker can load it without the rest of the app.
import type { Kysely } from "kysely";
import type { DB } from "@/lib/db/generated/database";
import type { CanonicalSchema } from "@/lib/schema/fields/types";
import type { ModelRef } from "@/lib/developer/items/access";

export async function loadModelRefs(db: Kysely<DB>, workspaceId: string, apiKeys: readonly string[]): Promise<ModelRef[]> {
  if (!apiKeys.length) return [];
  const rows = await db.selectFrom("content_models as m")
    .innerJoin("content_model_versions as v", (join) => join.onRef("v.content_model_id", "=", "m.id").onRef("v.version_number", "=", "m.current_schema_version"))
    .select(["m.id", "m.api_key", "m.workspace_id", "v.schema_json", "v.schema_hash"])
    .where("m.workspace_id", "=", workspaceId).where("m.status", "=", "active").where("m.api_key", "in", [...apiKeys])
    .execute();
  return rows.map((row) => ({ id: row.id, apiKey: row.api_key, workspaceId: row.workspace_id, schema: row.schema_json as unknown as CanonicalSchema, schemaHash: row.schema_hash }));
}
