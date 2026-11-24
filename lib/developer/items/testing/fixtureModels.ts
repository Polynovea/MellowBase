// Fixture models for the items API unit tests and the OpenAPI snapshot wave 2 builds against.
import type { CanonicalSchema, FieldDefinition } from "@/lib/schema/fields/types";

const f = (key: string, type: FieldDefinition["type"], extra: Partial<FieldDefinition> = {}): FieldDefinition =>
  ({ key, label: key.replace(/_/g, " "), type, required: false, localized: false, unique: false, ...extra });

export const PERSON_SCHEMA: CanonicalSchema = {
  name: "Person",
  apiKey: "person",
  fields: [f("name", "text", { required: true }), f("email", "email"), f("salary", "integer")],
};

export const ARTICLE_SCHEMA: CanonicalSchema = {
  name: "Article",
  apiKey: "article",
  fields: [
    f("title", "text", { required: true, validation: { maxLength: 200 } }),
    f("slug", "slug", { generatedFrom: "title", unique: true }),
    f("body", "rich_text"),
    f("rating", "integer", { validation: { min: 0, max: 5 } }),
    f("published_on", "date"),
    f("featured", "boolean"),
    f("tags", "multi_select", { validation: { options: ["news", "guide", "release"] } }),
    f("status_note", "select", { validation: { options: ["ok", "hold"] } }),
    f("author", "relation", { relation: { targetModelApiKey: "person", cardinality: "many_to_one", onDelete: "remove_reference" } }),
    f("related", "relation", { relation: { targetModelApiKey: "article", cardinality: "many_to_many", onDelete: "remove_reference" } }),
    f("meta", "json"),
    f("secret", "text"),
  ],
};

export const FIXTURE_HASHES = {
  article: "a".repeat(64),
  person: "b".repeat(64),
};
