/**
 * THE permission function of the generated API and its side channels (Phase 4).
 *
 * `resolveModelAccess(principal, model)` decides, once per model per request, what the caller may do
 * with the model and with each of its fields. Every channel consumes only its result:
 * output fields, filters, sort, search, expansion (filter.ts reads `lookupFor`), writes (`sanitise`
 * "in"), and the side channels (webhooks, scheduled publishing, previews, MCP, search) through the
 * same object. Nothing else reads content_field_permissions or decides field visibility.
 *
 * The rule (design note §3.2):
 * - A principal whose roles include the workspace `owner` role bypasses field rules.
 * - Otherwise, per field, each of the principal's roles with a content_field_permissions row decides
 *   for itself (can_read / can_write); a role with no row for the field falls back to the model
 *   level. Several roles: the union of their allows.
 * - Model level: the token scope (or the admin permission key) for the operation, the token's
 *   allowed models, and the model's own schema policy (modelPolicyAllows, one copy shared with
 *   canActorOperateModel) for principals that carry roles.
 * - With no field rows, every field is readable, as before Phase 4.
 */
import type { DbExecutor } from "@/lib/db/index";
import type { CanonicalSchema, FieldDefinition } from "@/lib/schema/fields/types";
import { modelPolicyAllows } from "@/lib/schema/modelPolicy";
import { ItemsApiError } from "@/lib/developer/items/errors";
import type { FieldLookup, ResolvedField } from "@/lib/developer/items/filter";
import { HARD_LIMITS, MIN_LIMITS, SYSTEM_FIELDS, operatorClassFor, type ApiLimits, type Channel } from "@/lib/developer/items/types";

export type PrincipalKind = "token" | "admin" | "preview" | "webhook" | "schedule" | "agent";

export interface Principal {
  workspaceId: string;
  kind: PrincipalKind;
  /** Workspace roles (roles.id) whose field rules apply. */
  roleIds: readonly string[];
  /** The same roles' keys (schema policies name roles by key). */
  roleKeys: readonly string[];
  /** Token scopes (`content.read`...) or, for admins, permission keys (`content.entry.read`...). */
  scopes: ReadonlySet<string>;
  /** Model api keys the principal may use; null = every model. */
  allowedModels: readonly string[] | null;
  /** Apply the model's schema policy (false only for a token without a role: today's behaviour). */
  applyModelPolicy: boolean;
  /** Per-role limit overrides (roles.api_limits), already merged across roles. Can only lower. */
  limitOverrides?: Partial<ApiLimits>;
}

export interface ModelRef {
  id: string;
  apiKey: string;
  workspaceId: string;
  schema: CanonicalSchema;
  schemaHash: string;
}

export interface ModelAccess {
  model: ModelRef;
  canRead: boolean;
  canWrite: boolean;
  canDelete: boolean;
  canPublish: boolean;
  /** Field keys of the current version the principal may read / write. Write implies read. */
  readable: ReadonlySet<string>;
  writable: ReadonlySet<string>;
  /** Readable fields, resolved for filter/sort/search/expand (and the system fields). */
  fields: ReadonlyMap<string, ResolvedField>;
  limits: ApiLimits;
  /** True when some field of the model is hidden from this principal (search must avoid search_text). */
  restricted: boolean;
}

export interface FieldRuleRow {
  field_key: string;
  role_id: string;
  can_read: boolean;
  can_write: boolean;
}

const OWNER_ROLE_KEY = "owner";

const OPERATION_KEYS = {
  token: { read: "content.read", write: "content.write", delete: "content.delete", publish: "content.publish" },
  admin: { read: "content.entry.read", write: "content.entry.edit", delete: "content.entry.archive", publish: "content.entry.publish" },
} as const;

export function bypassesFieldRules(principal: Pick<Principal, "roleKeys">): boolean {
  return principal.roleKeys.includes(OWNER_ROLE_KEY);
}

/** The principal's limits: the hard caps, lowered (never raised) by its role overrides. */
export function effectiveLimits(overrides?: Partial<ApiLimits>): ApiLimits {
  const limits = { ...HARD_LIMITS };
  for (const key of Object.keys(HARD_LIMITS) as Array<keyof ApiLimits>) {
    const value = overrides?.[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      limits[key] = Math.max(MIN_LIMITS[key], Math.min(HARD_LIMITS[key], Math.floor(value)));
    }
  }
  limits.defaultPageSize = Math.min(limits.defaultPageSize, limits.pageSize);
  return limits;
}

/** Merges several roles' overrides: for each limit, the most generous role wins (still under the caps). */
export function mergeLimitOverrides(perRole: ReadonlyArray<Partial<ApiLimits> | null | undefined>): Partial<ApiLimits> | undefined {
  const present = perRole.filter((value): value is Partial<ApiLimits> => Boolean(value) && typeof value === "object");
  if (!present.length || present.length < perRole.length) return undefined; // a role without overrides has the caps
  const merged: Partial<ApiLimits> = {};
  for (const key of Object.keys(HARD_LIMITS) as Array<keyof ApiLimits>) {
    const values = present.map((value) => value[key]);
    if (values.every((value) => typeof value === "number")) merged[key] = Math.max(...(values as number[]));
  }
  return merged;
}

const isToMany = (field: FieldDefinition) =>
  field.type === "relation" && (field.relation?.cardinality === "one_to_many" || field.relation?.cardinality === "many_to_many");

function resolvedField(field: FieldDefinition): ResolvedField {
  return {
    key: field.key,
    type: field.type,
    cls: operatorClassFor(field.type, !isToMany(field)),
    system: false,
    ...(field.type === "relation" && field.relation ? { relation: { target: field.relation.targetModelApiKey, toMany: isToMany(field) } } : {}),
  };
}

const SYSTEM_RESOLVED: ReadonlyMap<string, ResolvedField> = new Map(Object.entries(SYSTEM_FIELDS).map(([key, type]) => [
  key,
  { key, type, cls: type === "uuid" ? "uuid" : type === "datetime" ? "ordered" : "text", system: true } satisfies ResolvedField,
]));

/** The pure decision, given the model, the principal and the field rule rows of the principal's roles. */
export function decideModelAccess(principal: Principal, model: ModelRef, rules: readonly FieldRuleRow[]): ModelAccess {
  const limits = effectiveLimits(principal.limitOverrides);
  const sameWorkspace = principal.workspaceId === model.workspaceId;
  const modelAllowed = sameWorkspace && (principal.allowedModels === null || principal.allowedModels.length === 0 || principal.allowedModels.includes(model.apiKey));
  const keys = principal.kind === "token" || principal.kind === "agent" ? OPERATION_KEYS.token : OPERATION_KEYS.admin;
  const policy = (operation: "read" | "edit" | "archive" | "publish" | "delete") =>
    !principal.applyModelPolicy || bypassesFieldRules(principal) || modelPolicyAllows(model.schema, principal.roleKeys, operation);
  const canRead = modelAllowed && principal.scopes.has(keys.read) && policy("read");
  const canWrite = canRead && principal.scopes.has(keys.write) && policy("edit");
  // DELETE archives the entry (recoverable), so it is the schema's "archive" operation.
  const canDelete = canRead && principal.scopes.has(keys.delete) && policy("archive");
  const canPublish = canRead && principal.scopes.has(keys.publish) && policy("publish");

  const readable = new Set<string>();
  const writable = new Set<string>();
  const roleIds = new Set(principal.roleIds);
  const byField = new Map<string, FieldRuleRow[]>();
  for (const rule of rules) {
    if (!roleIds.has(rule.role_id)) continue; // only this principal's roles
    const list = byField.get(rule.field_key) ?? [];
    list.push(rule);
    byField.set(rule.field_key, list);
  }
  const bypass = bypassesFieldRules(principal);
  for (const field of model.schema.fields) {
    if (!canRead) break;
    if (bypass) {
      readable.add(field.key);
      if (canWrite) writable.add(field.key);
      continue;
    }
    const rows = byField.get(field.key) ?? [];
    // Roles with a row decide for themselves; any role without a row falls back to the model level.
    const someRoleWithoutRow = principal.roleIds.length === 0 || principal.roleIds.some((id) => !rows.some((row) => row.role_id === id));
    const read = someRoleWithoutRow || rows.some((row) => row.can_read);
    const write = canWrite && (someRoleWithoutRow || rows.some((row) => row.can_write && row.can_read));
    if (read) readable.add(field.key);
    if (read && write) writable.add(field.key);
  }

  const fields = new Map<string, ResolvedField>();
  if (canRead) {
    for (const [key, field] of SYSTEM_RESOLVED) fields.set(key, field);
    for (const field of model.schema.fields) if (readable.has(field.key)) fields.set(field.key, resolvedField(field));
  }
  return {
    model,
    canRead,
    canWrite,
    canDelete,
    canPublish,
    readable,
    writable,
    fields,
    limits,
    restricted: canRead && readable.size < model.schema.fields.length,
  };
}

/**
 * Loads the field rules of the principal's roles for the model and decides. One query; the decision
 * itself is decideModelAccess.
 */
export async function resolveModelAccess(principal: Principal, model: ModelRef, db: DbExecutor): Promise<ModelAccess> {
  const rules = principal.roleIds.length && !bypassesFieldRules(principal)
    ? await db.selectFrom("content_field_permissions")
      .select(["field_key", "role_id", "can_read", "can_write"])
      .where("workspace_id", "=", model.workspaceId)
      .where("content_model_id", "=", model.id)
      .where("role_id", "in", [...principal.roleIds])
      .execute()
    : [];
  return decideModelAccess(principal, model, rules);
}

/** The same decision for several models with one query for all their field rules. */
export async function resolveModelAccesses(principal: Principal, models: readonly ModelRef[], db: DbExecutor): Promise<Map<string, ModelAccess>> {
  const ids = [...new Set(models.map((model) => model.id))];
  const rules = ids.length && principal.roleIds.length && !bypassesFieldRules(principal)
    ? await db.selectFrom("content_field_permissions")
      .select(["content_model_id", "field_key", "role_id", "can_read", "can_write"])
      .where("workspace_id", "=", principal.workspaceId)
      .where("content_model_id", "in", ids)
      .where("role_id", "in", [...principal.roleIds])
      .execute()
    : [];
  return new Map(models.map((model) => [model.apiKey, decideModelAccess(principal, model, rules.filter((rule) => rule.content_model_id === model.id))]));
}

/**
 * The field lookup every parser uses: a field that does not exist and a field the caller cannot read
 * (or of a model the caller cannot read, or that was not resolved) give the same `null`, from the same
 * in-memory maps, so no channel can tell them apart or time the difference.
 */
export function lookupFor(accesses: Iterable<ModelAccess>): FieldLookup {
  const byModel = new Map<string, ModelAccess>();
  for (const access of accesses) byModel.set(access.model.apiKey, access);
  return {
    field(model, key) {
      const access = byModel.get(model);
      if (!access || !access.canRead) return null;
      return access.fields.get(key) ?? null;
    },
  };
}

export type Direction = "in" | "out";

/**
 * THE sanitiser, for both directions.
 * - "out": keeps only readable keys (unknown keys in stored data are dropped too). Never throws.
 * - "in": every key must be writable. Unknown or unreadable keys → UNKNOWN_FIELD; readable but not
 *   writable → FIELD_READ_ONLY. Nothing is ever dropped silently. All bad keys are listed.
 */
export function sanitise(access: ModelAccess, data: unknown, direction: "out"): Record<string, unknown>;
export function sanitise(access: ModelAccess, data: unknown, direction: "in"): Record<string, unknown>;
export function sanitise(access: ModelAccess, data: unknown, direction: Direction): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (direction === "out") {
    if (!access.canRead || typeof data !== "object" || data === null || Array.isArray(data)) return out;
    for (const [key, value] of Object.entries(data)) if (access.readable.has(key)) out[key] = value;
    return out;
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new ItemsApiError("VALIDATION_FAILED", "The request body must be a JSON object of field values");
  }
  const unknown: string[] = [];
  const readOnly: string[] = [];
  for (const [key, value] of Object.entries(data)) {
    if (!access.readable.has(key)) unknown.push(key.slice(0, 64));
    else if (!access.writable.has(key)) readOnly.push(key);
    else out[key] = value;
  }
  if (unknown.length) throw new ItemsApiError("UNKNOWN_FIELD", `Unknown field${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}`, { fields: unknown, where: "body" });
  if (readOnly.length) throw new ItemsApiError("FIELD_READ_ONLY", `Field${readOnly.length === 1 ? "" : "s"} you cannot change: ${readOnly.join(", ")}`, { fields: readOnly });
  return out;
}

/** May this principal use this field in this channel? The same answer for every channel that reads. */
export function canUseField(access: ModelAccess, key: string, channel: Channel): boolean {
  if (channel === "write") return access.writable.has(key);
  return access.fields.has(key);
}
