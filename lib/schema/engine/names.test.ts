import { describe, expect, it } from "vitest";
import { assertIdentifier, derivedName, nameProblem, NAME_PATTERN, POSTGRES_RESERVED_WORDS, TABLE_NAME_PATTERN, tableNameCandidates } from "@/lib/schema/engine/names";
import { DEFAULT_SCHEMA_LIMITS, SCHEMA_LIMIT_ENV, schemaLimitsFromEnv } from "@/lib/schema/engine/limits";

describe("name rules", () => {
  it("accepts lowercase snake_case names up to 63 characters", () => {
    for (const name of ["title", "a", "body_text", "x9", `a${"b".repeat(62)}`]) {
      expect(nameProblem(name, "field"), name).toBeNull();
      expect(nameProblem(name, "model"), name).toBeNull();
    }
  });

  it("refuses names that break the pattern, including injection attempts", () => {
    for (const name of ["", "Title", "9lives", "_hidden", "has-dash", "has space", `a${"b".repeat(63)}`, 'x"; drop table users; --', "naïve", "a.b"]) {
      expect(nameProblem(name, "field")?.code, name).toBe("invalid_name");
    }
  });

  it("refuses PostgreSQL reserved words", () => {
    for (const word of ["order", "user", "select", "table", "group", "limit", "offset", "join", "similar"]) {
      expect(nameProblem(word, "field")?.code, word).toBe("reserved_word");
      expect(nameProblem(word, "model")?.code, word).toBe("reserved_word");
    }
    expect(nameProblem("order_number", "field")).toBeNull();
    expect([...POSTGRES_RESERVED_WORDS].every((word) => NAME_PATTERN.test(word))).toBe(true);
  });

  it("refuses system prefixes, system columns and storage columns", () => {
    expect(nameProblem("pg_stats", "model")?.code).toBe("system_name");
    expect(nameProblem("polynovea_secret", "field")?.code).toBe("system_name");
    for (const name of ["ctid", "xmin", "oid", "tableoid", "entry_id", "variant", "locale", "id"]) {
      expect(nameProblem(name, "field")?.code, name).toBe("system_name");
    }
    // Storage column names are fine as model api keys: the table name carries its own prefix.
    expect(nameProblem("locale", "model")).toBeNull();
  });

  it("gives every new model a valid, prefixed table name, different per workspace on collision", () => {
    const [plain, hashed] = tableNameCandidates("ws-1", "blog_post");
    expect(plain).toBe("m_blog_post");
    expect(hashed).toMatch(TABLE_NAME_PATTERN);
    expect(tableNameCandidates("ws-2", "blog_post")[1]).not.toBe(hashed);
    const long = tableNameCandidates("ws-1", `a${"b".repeat(62)}`);
    expect(long).toHaveLength(1);
    expect(long[0].length).toBeLessThanOrEqual(63);
    expect(long[0]).toMatch(TABLE_NAME_PATTERN);
  });

  it("derives deterministic, valid index and constraint names", () => {
    const name = derivedName("uq", "m_blog_post", "title");
    expect(name).toBe(derivedName("uq", "m_blog_post", "title"));
    expect(name).not.toBe(derivedName("uq", "m_blog_post", "slug"));
    expect(name).not.toBe(derivedName("uq", "m_blog_posts", "title"));
    expect(assertIdentifier(name)).toBe(name);
    expect(name.length).toBeLessThanOrEqual(63);
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
