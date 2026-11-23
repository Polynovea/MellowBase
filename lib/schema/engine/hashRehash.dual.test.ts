// Migration 0075: the SQL twin of the schema hash must produce exactly the JavaScript text, and the
// migration's re-hash must rewrite stored versions and every copy of their hashes.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { describeWithDatabase } from "@/lib/db/testing/database";
import { canonicalJson, hashModelSchema } from "@/lib/schema/engine/hash";
import { computeSchemaHash, createModel, getVersion } from "@/lib/schema/modelService";
import type { CanonicalSchema } from "@/lib/schema/fields/types";

const AWKWARD: unknown[] = [
  { b: 1, a: 2, aa: 3, B: 4, "": 5 },
  { "é": 1, "e": 2, "中文": 3, "😀": 4, "": 5, "z": { "y": [3, 2, 1], "x": {} } },
  { s: "quote\" back\\ slash/ newline\n tab\t ctrl\u0001\u001f del\u007f sep  nbsp  emoji😀" },
  { n: [0, -0, 1, -1, 1.5, 99.99, 0.1, 0.000001, 123456789, 123456789012345680000, -2.5, 3.14159265358979] },
  { t: true, f: false, z: null, e: [], o: {}, deep: [[{ k: [null, { v: "x" }] }]] },
  { name: "Post", apiKey: "post", fields: [{ key: "title", label: "Title", type: "text", required: true, validation: { maxLength: 120, options: ["a", "b"] }, uiHints: { "help-text": "x" } }] },
];

/**
 * Numbers as they may sit in stored JSON text (not only as JSON.stringify writes them). The app reads
 * them back as JavaScript numbers, so SQL must produce what JavaScript would.
 */
const RAW_NUMBERS = [
  '{"n":[1.0, 1.50, -0, -0.0, 1E2, 1e2, 1e+2, 100.000]}',
  '{"n":[9007199254740993, 9007199254740992, 18014398509481985, 123456789012345678901234]}',
  '{"n":[1e-7, 1e-6, 0.000001, 0.00001, 0.0001, 1.5e-5, -2.5e-5]}',
  '{"n":[1e15, 1e16, 1e20, 1e21, 1.5e21, 1.5e300, 1e300, 1.7976931348623157e300]}',
  '{"n":[0.1, 0.2, 0.30000000000000004, 3.141592653589793, 2.718281828459045, 1.7976931348623157, 5e-300]}',
];

const legacyHash = (schema: CanonicalSchema) => createHash("sha256").update(JSON.stringify(schema, Object.keys(schema).sort())).digest("hex");

describeWithDatabase("schema hash re-hash (migration 0075)", (backend) => {
  it("polynovea_canonical_json matches the JavaScript canonical JSON exactly", async () => {
    for (const stored of [...AWKWARD.map((value) => JSON.stringify(value)), ...RAW_NUMBERS]) {
      const value: unknown = JSON.parse(stored);
      const [row] = await backend.query<{ text: string | null; hash: string | null }>(
        "select public.polynovea_canonical_json($1::jsonb) as text, encode(sha256(convert_to(public.polynovea_canonical_json($1::jsonb), 'UTF8')), 'hex') as hash", [stored]);
      expect(row.text, stored).toBe(canonicalJson(JSON.parse(stored)));
      expect(row.hash).toBe(hashModelSchema(value as CanonicalSchema));
    }
  });

  it("returns null for numbers it cannot reproduce byte for byte, so those versions keep their hash", async () => {
    for (const stored of ['{"n":1e309}', '{"deep":[{"n":-5e-324}]}', '[1, 2, 1e-400]']) {
      const [row] = await backend.query<{ text: string | null }>("select public.polynovea_canonical_json($1::jsonb) as text", [stored]);
      expect(row.text).toBeNull();
    }
  });

  it("re-hashes legacy versions and rewrites the copies in deployments, assessments and environments", async () => {
    const { workspaceId, adminUserId } = await backend.createWorkspace();
    const schema = { name: "Page", apiKey: "page", fields: [{ key: "title", label: "Title", type: "text", required: true }] };
    const created = await createModel({ workspaceId, createdBy: adminUserId, proposedSchema: schema });
    if (!created.ok) throw new Error(created.error);
    const modelId = created.data.model.id;
    const version = (await getVersion(modelId, 1))!;
    const correct = computeSchemaHash(version.schema_json);
    expect(version.schema_hash).toBe(correct);
    const legacy = legacyHash(version.schema_json);
    expect(legacy).not.toBe(correct);
    // The bug itself: another schema with one field of different content had the same legacy hash.
    expect(legacyHash({ ...version.schema_json, fields: [{ ...version.schema_json.fields[0], key: "other", type: "json" }] })).toBe(legacy);

    const [environment] = await backend.query<{ id: string }>("insert into workspace_environments (workspace_id, key, name, kind, deployed_schema_hash, deployed_schema_revision) values ($1, 'staging', 'Staging', 'staging', $2, 'page:v1') returning id", [workspaceId, legacy]);
    await backend.query("update content_model_versions set schema_hash = $1 where id = $2", [legacy, version.id]);
    await backend.query("insert into environment_schema_deployments (workspace_id, environment_id, content_model_id, schema_version, schema_hash) values ($1, $2, $3, 1, $4)", [workspaceId, environment.id, modelId, legacy]);
    const [assessment] = await backend.query<{ id: string }>(
      `insert into operational_change_assessments (workspace_id, environment_id, content_model_id, current_schema_version, proposed_schema_hash, status, deterministic_classification, target_schema_version, target_schema_hash, source_schema_version, source_schema_hash, provenance_state)
       values ($1, $2, $3, 1, $4, 'passed', 'safe', 1, $4, 1, $4, 'unverified') returning id`, [workspaceId, environment.id, modelId, legacy]);

    const migration = readFileSync(path.join(process.cwd(), "supabase", "migrations", "0075_schema_hash_rehash.sql"), "utf8").replace(/\r\n/g, "\n");
    const block = migration.match(/-- rehash:start\n([\s\S]*?)-- rehash:end/)?.[1];
    expect(block, "0075 must mark its re-hash with -- rehash:start / -- rehash:end").toBeTruthy();

    await backend.query("begin");
    try {
      await backend.query(block!);
      expect((await backend.query("select schema_hash from content_model_versions where id = $1", [version.id]))[0]).toEqual({ schema_hash: correct });
      expect((await backend.query("select schema_hash from environment_schema_deployments where content_model_id = $1", [modelId]))[0]).toEqual({ schema_hash: correct });
      expect((await backend.query("select proposed_schema_hash, target_schema_hash, source_schema_hash from operational_change_assessments where id = $1", [assessment.id]))[0])
        .toEqual({ proposed_schema_hash: correct, target_schema_hash: correct, source_schema_hash: correct });
      expect((await backend.query("select deployed_schema_hash from workspace_environments where id = $1", [environment.id]))[0]).toEqual({ deployed_schema_hash: correct });
    } finally {
      await backend.query("rollback");
    }
  });
});
