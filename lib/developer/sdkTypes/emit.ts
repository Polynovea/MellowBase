/**
 * The typed SDK's types file (Phase 4 wave 2): turns the per-caller items OpenAPI document
 * (lib/developer/items/openapi.ts, built from model metadata and the caller's access) into one
 * TypeScript module. Pure and deterministic, so `polynovea-cms types pull --check` can compare bytes.
 *
 * The output is self-contained (no imports): a project can use it with or without @polynovea/cms-sdk.
 * It only ever reflects the document it is given, so a field the caller cannot read never appears.
 */
import type { ItemsOpenApi } from "@/lib/developer/items/openapi";
import { itemPath, itemsPath } from "@/lib/developer/items/types";

type Json = Record<string, unknown>;

export interface EmitTypesOptions {
  /** Workspace-level hash of the listed models (the OpenAPI info `x-polynovea-schema-hash`). */
  schemaHash: string;
  /** Generation time, UTC ISO-8601 (`Date#toISOString`). On its own header line, which `--check` ignores. */
  generatedAt: string;
}

/** The header line holding the generation time. Drift checks compare everything except this line. */
export const GENERATED_AT_LINE = /^\/\/ generated-at: .*$/m;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;

export interface EmittedModel {
  apiKey: string;
  name: string;
  hash: string;
  fields: string[];
  writable: boolean;
  updatable: boolean;
  deletable: boolean;
}

const HASH = /^[0-9a-f]{64}$/;
const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** TS property name: bare when it is an identifier, quoted otherwise. */
const prop = (key: string) => (IDENT.test(key) ? key : JSON.stringify(key));
/** TS type name for a component (W1's componentName may start with a digit for odd api keys). */
const typeName = (component: string) => (/^[0-9]/.test(component) ? `_${component}` : component);
/** Text safe inside a single-line block comment. */
const CONTROL = new RegExp("[\u0000-\u001f\u007f\u2028\u2029]", "g");
const commentText = (text: string) => text.replace(CONTROL, " ").split("*/").join("*\\/").trim();
const literal = (value: unknown) => JSON.stringify(value);
const refName = (ref: string) => typeName(ref.replace(/^#\/components\/schemas\//, ""));

/** A JSON Schema fragment (the shapes W1's builder produces) as a TS type. */
function tsType(schema: Json | undefined): string {
  if (!schema || typeof schema !== "object") return "unknown";
  if (typeof schema.$ref === "string") return refName(schema.$ref);
  if (Array.isArray(schema.oneOf)) return [...new Set((schema.oneOf as Json[]).map(tsType))].join(" | ");
  if (Array.isArray(schema.enum)) return (schema.enum as unknown[]).map(literal).join(" | ") || "never";
  const type = schema.type;
  if (Array.isArray(type)) {
    return type.map((t) => (t === "null" ? "null" : tsType({ ...schema, type: t }))).join(" | ");
  }
  switch (type) {
    case "string": return "string";
    case "number":
    case "integer": return "number";
    case "boolean": return "boolean";
    case "array": {
      const inner = tsType(schema.items as Json | undefined);
      return /[|&]/.test(inner) ? `Array<${inner}>` : `${inner}[]`;
    }
    case "object": {
      const props = schema.properties as Record<string, Json> | undefined;
      if (props && Object.keys(props).length) {
        return `{ ${Object.entries(props).map(([k, v]) => `${prop(k)}: ${tsType(v)}`).join("; ")} }`;
      }
      return "Record<string, unknown>";
    }
    default: return "unknown";
  }
}

function fieldDoc(schema: Json): string {
  const title = typeof schema.title === "string" ? schema.title : "";
  const type = typeof schema["x-polynovea-field-type"] === "string" ? schema["x-polynovea-field-type"] : "";
  const text = commentText([title, type && `(${type})`].filter(Boolean).join(" "));
  return text ? `  /** ${text} */\n` : "";
}

function interfaceBody(props: Record<string, Json>, required: ReadonlySet<string>): string {
  return Object.entries(props)
    .map(([key, schema]) => `${fieldDoc(schema)}  ${prop(key)}${required.has(key) ? "" : "?"}: ${tsType(schema)};\n`)
    .join("");
}

/** The operator object a filter condition takes for one field, exactly one operator. */
function opsType(ops: Json, multiOptions: unknown[] | null): string {
  const props = (ops.properties ?? {}) as Record<string, Json>;
  const entries = Object.entries(props).map(([op, value]) => {
    const t = op === "contains" && multiOptions ? multiOptions.map(literal).join(" | ") : tsType(value);
    return `${prop(op)}: ${t}`;
  });
  return `OneOf<{ ${entries.join("; ")} }>`;
}

function conditionType(schema: Json, dataProp: Json | undefined): string {
  const items = dataProp?.items as Json | undefined;
  const multi = dataProp?.["x-polynovea-field-type"] === "multi_select" && Array.isArray(items?.enum) ? (items!.enum as unknown[]) : null;
  if (Array.isArray(schema.oneOf)) {
    return (schema.oneOf as Json[]).map((part) => (typeof part.$ref === "string" ? refName(part.$ref) : opsType(part, multi))).join(" | ");
  }
  return opsType(schema, multi);
}

function relationTarget(schema: Json): string | null {
  const rel = schema["x-polynovea-relation"] as { target?: unknown } | undefined;
  return rel && typeof rel.target === "string" ? rel.target : null;
}

/** Models in the document, in document order, with what the caller may do. */
export function modelsOf(doc: ItemsOpenApi): Array<EmittedModel & { component: string }> {
  const out: Array<EmittedModel & { component: string }> = [];
  for (const [name, schema] of Object.entries(doc.schemas)) {
    if (!name.endsWith("Item") || typeof schema["x-polynovea-model"] !== "string") continue;
    const apiKey = schema["x-polynovea-model"] as string;
    const component = name.slice(0, -"Item".length);
    const hash = String(schema["x-polynovea-schema-hash"] ?? "");
    if (!HASH.test(hash)) throw new Error(`Model ${apiKey} has no valid schema hash`);
    const data = doc.schemas[`${component}Data`] as Json | undefined;
    const fields = Object.keys((data?.properties ?? {}) as Json);
    const list = doc.paths[itemsPath(apiKey)] ?? {};
    const one = doc.paths[itemPath(apiKey, "{id}")] ?? {};
    const tag = (list.get as Json | undefined)?.tags as string[] | undefined;
    out.push({ apiKey, component, name: tag?.[0] ?? apiKey, hash, fields, writable: "post" in list, updatable: "patch" in one, deletable: "delete" in one });
  }
  return out;
}

/** Relation paths `expand` accepts for a model: its relations into listed models, and one more level. */
function expandPaths(doc: ItemsOpenApi, component: string, listed: Map<string, string>, depth: number): string[] {
  const data = doc.schemas[`${component}Data`] as Json | undefined;
  const props = (data?.properties ?? {}) as Record<string, Json>;
  const paths: string[] = [];
  for (const [key, schema] of Object.entries(props)) {
    const target = relationTarget(schema);
    const targetComponent = target ? listed.get(target) : undefined;
    if (!targetComponent) continue;
    paths.push(key);
    if (depth > 1) for (const sub of expandPaths(doc, targetComponent, listed, depth - 1)) paths.push(`${key}.${sub}`);
  }
  return paths;
}

const HEADER = `// Generated by Polynovea CMS from the API's model metadata, for the token that pulled it.
// Do not edit. Update with: polynovea-cms types pull   (check with: polynovea-cms types pull --check)
/* eslint-disable */

/** Exactly one key of T. */
type OneOf<T> = { [K in keyof T]: { [P in K]: T[P] } & { [P in Exclude<keyof T, K>]?: never } }[keyof T];

export interface ItemBase {
  id: string;
  locale: string;
  variant: "published" | "draft";
  version: number;
  createdAt: string;
  updatedAt: string;
  publishedAt: string | null;
}
`;

/** The types file for one caller's document. */
export function emitItemsTypes(doc: ItemsOpenApi, options: EmitTypesOptions): string {
  if (!HASH.test(options.schemaHash)) throw new Error("schemaHash must be 64 lowercase hex characters");
  if (!ISO_UTC.test(options.generatedAt)) throw new Error("generatedAt must be a UTC ISO-8601 time");
  const models = modelsOf(doc);
  const listed = new Map(models.map((m) => [m.apiKey, m.component]));
  const parts: string[] = [`// schema-hash: ${options.schemaHash}\n// generated-at: ${options.generatedAt}\n`, HEADER];
  const mapEntries: string[] = [];

  for (const model of models) {
    const C = model.component;
    const T = typeName(C);
    const data = doc.schemas[`${C}Data`] as Json;
    const dataProps = (data.properties ?? {}) as Record<string, Json>;
    const create = doc.schemas[`${C}Create`] as Json | undefined;
    const cond = doc.schemas[`${C}FieldCondition`] as Json | undefined;
    const sort = doc.schemas[`${C}SortKey`] as Json | undefined;

    parts.push(`\n// ${commentText(model.name)} (${commentText(model.apiKey)})\n`);
    parts.push(`export interface ${T}Data {\n${interfaceBody(dataProps, new Set())}}\n`);
    parts.push(`export interface ${T}Item extends ItemBase {\n  data: ${T}Data;\n}\n`);
    if (model.writable && create) {
      const required = new Set(Array.isArray(create.required) ? (create.required as string[]) : []);
      parts.push(`export interface ${T}Create {\n${interfaceBody((create.properties ?? {}) as Record<string, Json>, required)}}\n`);
    }
    if (model.updatable && create) {
      parts.push(`export interface ${T}Patch {\n${interfaceBody((create.properties ?? {}) as Record<string, Json>, new Set())}}\n`);
    }
    const condProps = (cond?.properties ?? {}) as Record<string, Json>;
    parts.push(`export type ${T}FieldCondition = OneOf<{\n${Object.entries(condProps).map(([key, schema]) => `  ${prop(key)}: ${conditionType(schema, dataProps[key])};\n`).join("")}}>;\n`);
    parts.push(`export type ${T}Filter = { and: ${T}Filter[] } | { or: ${T}Filter[] } | { not: ${T}Filter } | ${T}FieldCondition;\n`);
    const sortKeys = Array.isArray(sort?.enum) ? (sort!.enum as string[]) : [];
    parts.push(`export type ${T}SortKey =\n${sortKeys.length ? sortKeys.map((key) => `  | ${literal(key)}`).join("\n") : "  never"};\n`);
    const expand = expandPaths(doc, C, listed, 2);
    parts.push(`export type ${T}Expand = ${expand.length ? expand.map(literal).join(" | ") : "never"};\n`);

    mapEntries.push(`  ${prop(model.apiKey)}: {
    data: ${T}Data;
    item: ${T}Item;
    create: ${model.writable && create ? `${T}Create` : "never"};
    patch: ${model.updatable && create ? `${T}Patch` : "never"};
    filter: ${T}Filter;
    sort: ${T}SortKey;
    expand: ${T}Expand;
  };\n`);
  }

  parts.push(`\n/** Every model this token could read when the types were pulled. Plug into createCmsClient<Models>(). */\nexport interface Models {\n${mapEntries.join("")}}\n`);
  const manifest = models
    .map((m) => `    ${prop(m.apiKey)}: { hash: ${literal(m.hash)}, fields: [${m.fields.map(literal).join(", ")}] },\n`)
    .join("");
  parts.push(`\n/** Schema hashes and readable fields at pull time. The SDK sends these to detect breaking model changes. */\nexport const schema = {\n  hash: ${literal(options.schemaHash)},\n  models: {\n${manifest}  },\n} as const;\n`);
  return parts.join("");
}
