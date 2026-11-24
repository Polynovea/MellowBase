/**
 * OpenAPI for the generated items API, built from model metadata and the CALLER's access: only the
 * models and fields that caller can read appear, so the document never names a hidden field. Pure:
 * the route resolves the access (access.ts) and passes it in. The typed SDK (wave 2) is generated
 * from this shape.
 */
import type { CanonicalSchema, FieldDefinition } from "@/lib/schema/fields/types";
import {
  FILTER_OPERATORS,
  HARD_LIMITS,
  ITEM_ERROR_CODES,
  OPERATORS_BY_CLASS,
  PREVIEW_TOKEN_HEADER,
  SCHEMA_HASH_HEADER,
  SEARCH_TERM,
  SYSTEM_FIELDS,
  isSortableClass,
  itemPath,
  itemsPath,
  operatorClassFor,
  type FilterOperator,
  type OperatorClass,
} from "@/lib/developer/items/types";

export interface OpenApiModelInput {
  apiKey: string;
  name: string;
  schema: CanonicalSchema;
  schemaHash: string;
  /** Field keys the caller may read / write (from resolveModelAccess). */
  readable: ReadonlySet<string>;
  writable: ReadonlySet<string>;
  /** The caller may create, update, delete items of this model. */
  canWrite: boolean;
  canDelete: boolean;
}

type Json = Record<string, unknown>;

/** Identifier-safe component name for a model api key (`blog-post` → `Blog_post`). */
export function componentName(apiKey: string): string {
  const safe = apiKey.replace(/[^A-Za-z0-9_]/g, "_");
  return safe.charAt(0).toUpperCase() + safe.slice(1);
}

const isToMany = (field: FieldDefinition) =>
  field.type === "relation" && (field.relation?.cardinality === "one_to_many" || field.relation?.cardinality === "many_to_many");

/** Column-backed fields are filterable/sortable; to-many relations live outside the table. */
export const fieldOperatorClass = (field: FieldDefinition): OperatorClass => operatorClassFor(field.type, !isToMany(field));

function scalarSchema(field: FieldDefinition): Json {
  const base: Json = {};
  switch (field.type) {
    case "number": base.type = "number"; break;
    case "integer": base.type = "integer"; break;
    case "boolean": base.type = "boolean"; break;
    case "date": base.type = "string"; base.format = "date"; break;
    case "datetime": base.type = "string"; base.format = "date-time"; break;
    case "email": base.type = "string"; base.format = "email"; break;
    case "url": base.type = "string"; base.format = "uri-reference"; break;
    case "multi_select": base.type = "array"; base.items = { type: "string", ...(field.validation?.options?.length ? { enum: field.validation.options } : {}) }; break;
    case "json": break; // any JSON value
    case "rich_text":
    case "component": base.type = "object"; base.additionalProperties = true; break;
    case "repeater": base.type = "array"; base.items = { type: "object", additionalProperties: true }; break;
    default: base.type = "string";
  }
  const v = field.validation;
  if (v?.minLength !== undefined) base.minLength = v.minLength;
  if (v?.maxLength !== undefined) base.maxLength = v.maxLength;
  if (v?.min !== undefined) base.minimum = v.min;
  if (v?.max !== undefined) base.maximum = v.max;
  if (v?.pattern) base.pattern = v.pattern;
  if (v?.options?.length && field.type !== "multi_select") base.enum = v.options;
  return base;
}

function fieldSchema(field: FieldDefinition, docModels: ReadonlySet<string>): Json {
  const cls = fieldOperatorClass(field);
  const ext: Json = { "x-polynovea-field-type": field.type, "x-polynovea-filter-ops": OPERATORS_BY_CLASS[cls] };
  if (field.type === "relation" && field.relation) {
    const target = field.relation.targetModelApiKey;
    // Expanded: the target item; otherwise (or when the caller cannot read the target) its id.
    const one = docModels.has(target)
      ? { oneOf: [{ type: "string", format: "uuid" }, { $ref: `#/components/schemas/${componentName(target)}Item` }] }
      : { type: "string", format: "uuid" };
    const relation = { "x-polynovea-relation": { target, cardinality: field.relation.cardinality } };
    return isToMany(field)
      ? { title: field.label, type: "array", items: one, ...relation, ...ext }
      : { title: field.label, ...one, ...relation, ...ext };
  }
  return { title: field.label, ...scalarSchema(field), ...ext };
}

/** The value schema an operator takes for a field class. */
function opValueSchema(op: FilterOperator, field: FieldDefinition | null, systemType: string | null): Json {
  if (op === "null") return { type: "boolean" };
  const scalar: Json = systemType
    ? systemType === "uuid" ? { type: "string", format: "uuid" } : systemType === "datetime" ? { type: "string", format: "date-time" } : { type: "string" }
    : field!.type === "relation" ? { type: "string", format: "uuid" }
    : field!.type === "multi_select" ? { type: "string" }
    : scalarSchema(field!);
  if (op === "in") return { type: "array", items: scalar, minItems: 1, maxItems: HARD_LIMITS.inValues };
  if (op === "contains") return { type: "string", minLength: 1 };
  return scalar;
}

function opsSchema(ops: readonly FilterOperator[], field: FieldDefinition | null, systemType: string | null): Json {
  return {
    type: "object",
    minProperties: 1,
    maxProperties: 1,
    additionalProperties: false,
    properties: Object.fromEntries(ops.map((op) => [op, opValueSchema(op, field, systemType)])),
  };
}

export interface ItemsOpenApi {
  paths: Record<string, Json>;
  schemas: Record<string, Json>;
  parameters: Record<string, Json>;
  responses: Record<string, Json>;
}

const SYSTEM_CLASS: Record<string, OperatorClass> = { uuid: "uuid", datetime: "ordered", text: "text" };

export function buildItemsOpenApi(models: readonly OpenApiModelInput[]): ItemsOpenApi {
  const docModels = new Set(models.map((model) => model.apiKey));
  const paths: Record<string, Json> = {};
  const schemas: Record<string, Json> = {
    ItemListMeta: {
      type: "object",
      properties: {
        requestId: { type: "string" },
        timestamp: { type: "string", format: "date-time" },
        schemaHash: { type: "string", pattern: "^[0-9a-f]{64}$" },
        page: {
          type: "object",
          properties: { limit: { type: "integer" }, nextCursor: { type: ["string", "null"] } },
          required: ["limit", "nextCursor"],
        },
        rateLimit: { $ref: "#/components/schemas/RateLimitMeta" },
      },
      required: ["requestId", "timestamp", "schemaHash", "page"],
    },
    ItemMeta: {
      type: "object",
      properties: {
        requestId: { type: "string" },
        timestamp: { type: "string", format: "date-time" },
        schemaHash: { type: "string", pattern: "^[0-9a-f]{64}$" },
        rateLimit: { $ref: "#/components/schemas/RateLimitMeta" },
      },
      required: ["requestId", "timestamp", "schemaHash"],
    },
    RateLimitMeta: {
      type: "object",
      properties: { limit: { type: "integer" }, remaining: { type: "integer" }, resetAt: { type: "string" } },
      required: ["limit", "remaining", "resetAt"],
    },
    ItemErrorCode: { type: "string", enum: [...ITEM_ERROR_CODES] },
    ItemError: {
      type: "object",
      properties: {
        error: {
          type: "object",
          properties: { code: { $ref: "#/components/schemas/ItemErrorCode" }, message: { type: "string" }, details: {} },
          required: ["code", "message"],
        },
        meta: { type: "object", properties: { requestId: { type: "string" }, timestamp: { type: "string", format: "date-time" } }, required: ["requestId", "timestamp"] },
      },
      required: ["error", "meta"],
    },
  };

  const parameters: Record<string, Json> = {
    ItemId: { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } },
    Search: { name: "search", in: "query", schema: { type: "string", minLength: SEARCH_TERM.min, maxLength: SEARCH_TERM.max } },
    Limit: { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: HARD_LIMITS.pageSize, default: HARD_LIMITS.defaultPageSize } },
    Cursor: { name: "cursor", in: "query", schema: { type: "string" } },
    Locale: { name: "locale", in: "query", schema: { type: "string" } },
    Variant: { name: "variant", in: "query", schema: { type: "string", enum: ["published", "draft"], default: "published" }, description: `draft needs a preview token (${PREVIEW_TOKEN_HEADER} header) or the content.preview scope` },
    PreviewToken: { name: PREVIEW_TOKEN_HEADER, in: "header", schema: { type: "string" } },
    Fields: { name: "fields", in: "query", schema: { type: "string" }, description: "Comma-separated field keys to return (each must be readable)" },
    Expand: { name: "expand", in: "query", schema: { type: "string" }, description: `Comma-separated relation paths, e.g. author,author.company (depth up to ${HARD_LIMITS.expandDepth})` },
  };

  const responses: Record<string, Json> = Object.fromEntries(
    [["BadRequest", "Invalid parameter, filter, sort, expansion or write body"], ["Unauthorized", "Invalid, expired or revoked API token"], ["Forbidden", "Token lacks scope, model access or a preview token"], ["NotFound", "Model or item not found"], ["RateLimited", "Rate limit exceeded"], ["Unavailable", "The model's table is not ready (Retry-After) or the query timed out"]]
      .map(([name, description]) => [name, { description, content: { "application/json": { schema: { $ref: "#/components/schemas/ItemError" } } } }]),
  );
  const errorRefs = (...names: string[]) => Object.fromEntries(names.map((name) => [
    { BadRequest: "400", Unauthorized: "401", Forbidden: "403", NotFound: "404", RateLimited: "429", Unavailable: "503" }[name]!,
    { $ref: `#/components/responses/${name}` },
  ]));
  const hashHeader = { [SCHEMA_HASH_HEADER]: { schema: { type: "string" }, description: "The model's current schema hash" } };

  for (const model of models) {
    const M = componentName(model.apiKey);
    const readable = model.schema.fields.filter((field) => model.readable.has(field.key));
    const writable = model.schema.fields.filter((field) => model.writable.has(field.key) && model.readable.has(field.key));

    schemas[`${M}Data`] = {
      type: "object",
      properties: Object.fromEntries(readable.map((field) => [field.key, fieldSchema(field, docModels)])),
      additionalProperties: false,
      "x-polynovea-model": model.apiKey,
    };
    schemas[`${M}Item`] = {
      type: "object",
      properties: {
        id: { type: "string", format: "uuid" },
        locale: { type: "string" },
        variant: { type: "string", enum: ["published", "draft"] },
        version: { type: "integer" },
        createdAt: { type: "string", format: "date-time" },
        updatedAt: { type: "string", format: "date-time" },
        publishedAt: { type: ["string", "null"], format: "date-time" },
        data: { $ref: `#/components/schemas/${M}Data` },
      },
      required: ["id", "locale", "variant", "version", "createdAt", "updatedAt", "publishedAt", "data"],
      "x-polynovea-model": model.apiKey,
      "x-polynovea-schema-hash": model.schemaHash,
    };
    const writeProps = Object.fromEntries(writable.map((field) => [field.key, fieldSchema(field, new Set())]));
    schemas[`${M}Create`] = {
      type: "object",
      properties: writeProps,
      ...(writable.some((field) => field.required) ? { required: writable.filter((field) => field.required).map((field) => field.key) } : {}),
      additionalProperties: false,
    };
    schemas[`${M}Patch`] = { type: "object", properties: writeProps, additionalProperties: false, minProperties: 1 };

    // Filter: per-field operator objects; a to-one relation also takes one hop into its target.
    const fieldConds: Record<string, Json> = {};
    for (const [key, type] of Object.entries(SYSTEM_FIELDS)) fieldConds[key] = opsSchema(OPERATORS_BY_CLASS[SYSTEM_CLASS[type]], null, type);
    for (const field of readable) {
      const ops = OPERATORS_BY_CLASS[fieldOperatorClass(field)];
      if (!ops.length) continue;
      const own = opsSchema(ops, field, null);
      const target = field.relation?.targetModelApiKey;
      fieldConds[field.key] = field.type === "relation" && target && docModels.has(target)
        ? { oneOf: [own, { $ref: `#/components/schemas/${componentName(target)}FieldCondition` }] }
        : own;
    }
    schemas[`${M}FieldCondition`] = { type: "object", minProperties: 1, maxProperties: 1, additionalProperties: false, properties: fieldConds };
    schemas[`${M}Filter`] = {
      oneOf: [
        { type: "object", properties: { and: { type: "array", items: { $ref: `#/components/schemas/${M}Filter` }, minItems: 1, maxItems: HARD_LIMITS.groupItems } }, required: ["and"], additionalProperties: false },
        { type: "object", properties: { or: { type: "array", items: { $ref: `#/components/schemas/${M}Filter` }, minItems: 1, maxItems: HARD_LIMITS.groupItems } }, required: ["or"], additionalProperties: false },
        { type: "object", properties: { not: { $ref: `#/components/schemas/${M}Filter` } }, required: ["not"], additionalProperties: false },
        { $ref: `#/components/schemas/${M}FieldCondition` },
      ],
      description: `JSON, URL-encoded in the filter parameter. Operators: ${FILTER_OPERATORS.join(", ")}. Depth up to ${HARD_LIMITS.filterDepth}, ${HARD_LIMITS.filterConditions} conditions.`,
    };
    const sortable = [
      ...Object.keys(SYSTEM_FIELDS),
      ...readable.filter((field) => isSortableClass(fieldOperatorClass(field))).map((field) => field.key),
    ];
    schemas[`${M}SortKey`] = { type: "string", enum: sortable.flatMap((key) => [key, `-${key}`]) };

    const listOk = { description: `${model.name} items`, headers: hashHeader, content: { "application/json": { schema: { type: "object", properties: { data: { type: "array", items: { $ref: `#/components/schemas/${M}Item` } }, meta: { $ref: "#/components/schemas/ItemListMeta" } }, required: ["data", "meta"] } } } };
    const oneOk = (description: string) => ({ description, headers: hashHeader, content: { "application/json": { schema: { type: "object", properties: { data: { $ref: `#/components/schemas/${M}Item` }, meta: { $ref: "#/components/schemas/ItemMeta" } }, required: ["data", "meta"] } } } });
    const p = (name: string) => ({ $ref: `#/components/parameters/${name}` });
    const json = (schema: string) => ({ required: true, content: { "application/json": { schema: { $ref: `#/components/schemas/${schema}` } } } });
    const common = { "x-polynovea-model": model.apiKey, tags: [model.name] };

    paths[itemsPath(model.apiKey)] = {
      get: {
        ...common, summary: `List ${model.name}`, operationId: `list_${M}`, security: [{ bearerAuth: [] }], "x-polynovea-scopes": ["content.read"],
        parameters: [
          { name: "filter", in: "query", content: { "application/json": { schema: { $ref: `#/components/schemas/${M}Filter` } } } },
          { name: "sort", in: "query", schema: { type: "string" }, description: `Comma-separated ${M}SortKey values, up to ${HARD_LIMITS.sortKeys}`, "x-polynovea-sort-key": { $ref: `#/components/schemas/${M}SortKey` } },
          p("Search"), p("Expand"), p("Fields"), p("Limit"), p("Cursor"), p("Locale"), p("Variant"), p("PreviewToken"),
        ],
        responses: { "200": listOk, ...errorRefs("BadRequest", "Unauthorized", "Forbidden", "NotFound", "RateLimited", "Unavailable") },
      },
      ...(model.canWrite ? {
        post: {
          ...common, summary: `Create a draft ${model.name}`, operationId: `create_${M}`, security: [{ bearerAuth: [] }], "x-polynovea-scopes": ["content.write"],
          requestBody: json(`${M}Create`),
          responses: { "201": oneOk(`The new draft ${model.name}`), ...errorRefs("BadRequest", "Unauthorized", "Forbidden", "NotFound", "RateLimited") },
        },
      } : {}),
    };
    paths[itemPath(model.apiKey, "{id}")] = {
      get: {
        ...common, summary: `Get one ${model.name}`, operationId: `get_${M}`, security: [{ bearerAuth: [] }], "x-polynovea-scopes": ["content.read"],
        parameters: [p("ItemId"), p("Expand"), p("Fields"), p("Locale"), p("Variant"), p("PreviewToken")],
        responses: { "200": oneOk(model.name), ...errorRefs("BadRequest", "Unauthorized", "Forbidden", "NotFound", "RateLimited", "Unavailable") },
      },
      ...(model.canWrite ? {
        patch: {
          ...common, summary: `Update a ${model.name} (new draft version)`, operationId: `update_${M}`, security: [{ bearerAuth: [] }], "x-polynovea-scopes": ["content.write"],
          parameters: [p("ItemId")], requestBody: json(`${M}Patch`),
          responses: { "200": oneOk(`The updated draft ${model.name}`), ...errorRefs("BadRequest", "Unauthorized", "Forbidden", "NotFound", "RateLimited") },
        },
      } : {}),
      ...(model.canDelete ? {
        delete: {
          ...common, summary: `Delete a ${model.name}`, operationId: `delete_${M}`, security: [{ bearerAuth: [] }], "x-polynovea-scopes": ["content.delete"],
          parameters: [p("ItemId")],
          responses: { "204": { description: "Deleted" }, ...errorRefs("Unauthorized", "Forbidden", "NotFound", "RateLimited") },
        },
      } : {}),
    };
  }
  return { paths, schemas, parameters, responses };
}
