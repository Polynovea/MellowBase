import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { validateCanonicalSchema } from "@/lib/schema/canonicalSchema";
import { columnNameFor, COLUMN_NAME_PATTERN, KEY_PATTERN, nameProblem, STORAGE_COLUMNS, SYSTEM_COLUMNS, TABLE_NAME_PATTERN, tableNameCandidates, assertIdentifier, derivedName } from "@/lib/schema/engine/names";
import { shapeForSchema } from "@/lib/schema/engine/columns";
import { buildMigrationPlan } from "@/lib/schema/engine/planner";
import { DEFAULT_SCHEMA_LIMITS, SCHEMA_LIMIT_ENV, schemaLimitsFromEnv } from "@/lib/schema/engine/limits";
import { MODEL_TEMPLATES } from "@/lib/schema/templates";
import { LANDING_PAGE_MODEL_SCHEMA } from "@/lib/experience/constants";
import type { CanonicalSchema, FieldDefinition } from "@/lib/schema/fields/types";

const f = (key: string, extra: Partial<FieldDefinition> = {}): FieldDefinition => ({ key, label: key, type: "text", required: false, localized: false, unique: false, ...extra });

function planCreate(schema: CanonicalSchema) {
  const result = buildMigrationPlan({
    workspaceId: "11111111-1111-4111-8111-111111111111", modelId: "22222222-2222-4222-8222-222222222222", modelApiKey: schema.apiKey,
    table: tableNameCandidates("w", schema.apiKey)[0],
    currentShape: null, currentSchema: null, targetSchema: schema,
  });
  return result;
}

describe("key rule (one rule for the canonical schema and the engine)", () => {
  it("is the canonical schema's rule: a lowercase letter, then lowercase letters, digits and underscores", () => {
    for (const key of ["title", "a", "order", "user", "from", "to", "default", "id", "locale", "variant", "entry_id", "xmin", "ctid", "pg_stats", "polynovea_x", `a${"b".repeat(100)}`]) {
      expect(nameProblem(key, "field"), key).toBeNull();
      expect(KEY_PATTERN.test(key)).toBe(true);
    }
    for (const key of ["", "Title", "9lives", "_hidden", "has-dash", "has space", 'x"; drop table users; --', "naïve", "a.b"]) {
      expect(nameProblem(key, "field")?.code, key).toBe("invalid_name");
    }
  });

  it("validateCanonicalSchema accepts and refuses exactly the same keys", () => {
    for (const key of ["order", "id", "locale", "xmin", "_hidden", "Title", `a${"b".repeat(100)}`]) {
      const result = validateCanonicalSchema({ name: "M", apiKey: "m", fields: [f(key)] });
      expect(result.valid, key).toBe(nameProblem(key, "field") === null);
    }
  });

  it("can never produce a storage column name: storage columns start with '_'", () => {
    for (const column of Object.values(STORAGE_COLUMNS)) {
      expect(column.startsWith("_")).toBe(true);
      expect(KEY_PATTERN.test(column)).toBe(false);
      expect(COLUMN_NAME_PATTERN.test(column)).toBe(false);
    }
  });
});

describe("column names", () => {
  it("are the key when it fits and is free", () => {
    expect(columnNameFor("order", new Set())).toBe("order");
    expect(columnNameFor("id", new Set())).toBe("id");
  });

  it("are derived (cut plus hash) for long keys, PostgreSQL system column names and collisions", () => {
    const long = columnNameFor(`a${"b".repeat(100)}`, new Set());
    expect(long.length).toBeLessThanOrEqual(63);
    for (const system of SYSTEM_COLUMNS) {
      const name = columnNameFor(system, new Set());
      expect(name).not.toBe(system);
      expect(name).toMatch(COLUMN_NAME_PATTERN);
    }
    const taken = new Set(["title"]);
    const other = columnNameFor("title", taken);
    expect(other).not.toBe("title");
    expect(columnNameFor("title", new Set([...taken, other]))).not.toBe(other);
    expect(columnNameFor("title", taken)).toBe(other); // deterministic
  });

  it("keep a field's column when other fields come and go, and never reuse a taken name", () => {
    const v1 = shapeForSchema("m_post", { name: "P", apiKey: "post", fields: [f("title")] });
    const v2 = shapeForSchema("m_post", { name: "P", apiKey: "post", fields: [f("body"), f("title")] }, v1);
    expect(v2.columns.title.field).toBe("title");
    expect(v2.columns.body.field).toBe("body");
    // A new field whose key equals a column still in the table (pending deletion) gets another name.
    const v3 = shapeForSchema("m_post", { name: "P", apiKey: "post", fields: [f("body"), f("title_new")] }, { table: "m_post", columns: { ...v2.columns, title_new: { ...v2.columns.title, name: "title_new", field: "old_field" } } });
    expect(Object.values(v3.columns).find((c) => c.field === "title_new")!.name).not.toBe("title_new");
  });
});

describe("every existing model can get a table with no change to its schema", () => {
  const blogPost = (() => {
    const sqlText = readFileSync(path.join(process.cwd(), "supabase", "migrations", "0010_blog_compatibility_backfill.sql"), "utf8");
    const json = sqlText.match(/'(\{"name":"Blog Post"[\s\S]*?\})'::jsonb/)?.[1];
    if (!json) throw new Error("blog_post seed schema not found in 0010");
    return JSON.parse(json) as CanonicalSchema;
  })();
  const seeds: [string, unknown][] = [
    ["blog_post (migration 0010)", blogPost],
    ["landing_page (experience)", LANDING_PAGE_MODEL_SCHEMA],
    ...MODEL_TEMPLATES.map((t) => [`template ${t.key}`, { ...t.schema, name: t.label, apiKey: t.key }] as [string, unknown]),
    ["keys that used to be refused", { name: "Edge", apiKey: "order", fields: [
      f("order"), f("user"), f("from"), f("to"), f("default"), f("id"), f("locale"), f("variant"), f("entry_id"), f("xmin"), f("ctid"),
      f("pg_thing"), f(`a${"b".repeat(100)}`), f(`a${"b".repeat(101)}`), f("link", { type: "relation" }),
    ] }],
  ];

  for (const [label, raw] of seeds) {
    it(label, () => {
      const validation = validateCanonicalSchema(raw);
      expect(validation.errors, label).toEqual([]);
      const result = planCreate(validation.schema!);
      expect(result.ok ? [] : result.problems, label).toEqual([]);
      if (!result.ok) return;
      const columns = Object.values(result.plan.targetShape!.columns);
      expect(new Set(columns.map((c) => c.name)).size).toBe(columns.length);
      for (const column of columns) expect(column.name).toMatch(COLUMN_NAME_PATTERN);
    });
  }
});

describe("table and derived names", () => {
  it("gives every new model a valid, prefixed table name, different per workspace on collision", () => {
    const [plain, hashed] = tableNameCandidates("ws-1", "blog_post");
    expect(plain).toBe("m_blog_post");
    expect(hashed).toMatch(TABLE_NAME_PATTERN);
    expect(tableNameCandidates("ws-2", "blog_post")[1]).not.toBe(hashed);
    const long = tableNameCandidates("ws-1", `a${"b".repeat(62)}`);
    expect(long).toHaveLength(1);
    expect(long[0]).toMatch(TABLE_NAME_PATTERN);
  });

  it("derives deterministic, valid index and constraint names", () => {
    const name = derivedName("uq", "m_blog_post", "title");
    expect(name).toBe(derivedName("uq", "m_blog_post", "title"));
    expect(name).not.toBe(derivedName("uq", "m_blog_post", "slug"));
    expect(assertIdentifier(name)).toBe(name);
  });

  it("assertIdentifier refuses anything outside the identifier pattern", () => {
    expect(() => assertIdentifier('a"b')).toThrow(/Unsafe SQL identifier/);
    expect(() => assertIdentifier("A")).toThrow();
    expect(() => assertIdentifier(undefined as unknown as string)).toThrow();
  });
});

describe("caps", () => {
  it("defaults to 200 models, 150 fields and 50 indexes per model", () => {
    expect(schemaLimitsFromEnv({})).toEqual({ maxModels: 200, maxFieldsPerModel: 150, maxIndexesPerModel: 50 });
    expect(DEFAULT_SCHEMA_LIMITS).toEqual(schemaLimitsFromEnv({}));
  });

  it("can be adjusted by the operator", () => {
    expect(schemaLimitsFromEnv({ [SCHEMA_LIMIT_ENV.maxModels]: "500", [SCHEMA_LIMIT_ENV.maxFieldsPerModel]: " 20 ", [SCHEMA_LIMIT_ENV.maxIndexesPerModel]: "5" }))
      .toEqual({ maxModels: 500, maxFieldsPerModel: 20, maxIndexesPerModel: 5 });
  });

  it("ignores values that are not positive whole numbers and clamps absurd ones", () => {
    for (const raw of ["0", "-5", "abc", "1.5", "", "1e3"]) {
      expect(schemaLimitsFromEnv({ [SCHEMA_LIMIT_ENV.maxModels]: raw }).maxModels, raw).toBe(200);
    }
    expect(schemaLimitsFromEnv({ [SCHEMA_LIMIT_ENV.maxFieldsPerModel]: "99999" }).maxFieldsPerModel).toBe(1500);
  });
});
