/**
 * Parsing and checking of the items API's query parameters: filter, sort, expand, fields. Pure: no
 * database, no SQL. Every name is looked up through the caller's access (`FieldLookup`, built by
 * access.ts from ONE resolveModelAccess per model), and a name that does not exist and a name the
 * caller cannot read come back identically as UNKNOWN_FIELD, from the same in-memory lookup.
 *
 * The output is an AST of resolved fields; query.ts turns it into SQL with identifiers taken only
 * from the resolved metadata.
 */
import { ItemsApiError, unknownField } from "@/lib/developer/items/errors";
import {
  FILTER_OPERATORS,
  OPERATORS_BY_CLASS,
  isSortableClass,
  type ApiLimits,
  type FilterOperator,
  type FilterScalar,
  type OperatorClass,
  type SortKey,
} from "@/lib/developer/items/types";

/** A field as the caller may use it. `column` is null for fields kept outside the table. */
export interface ResolvedField {
  key: string;
  /** Field type, or the system type (`uuid`, `datetime`, `text`) for system fields. */
  type: string;
  cls: OperatorClass;
  system: boolean;
  /** For relations: the target model's api key, and whether it holds one id or many. */
  relation?: { target: string; toMany: boolean };
}

export interface FieldLookup {
  /** The caller-visible field `key` of `model`, or null when it does not exist OR is not readable. */
  field(model: string, key: string): ResolvedField | null;
}

export type ParsedCond = { kind: "cond"; path: ResolvedField[]; model: string; op: FilterOperator; value: FilterScalar | FilterScalar[] | boolean };
export type ParsedFilter =
  | { kind: "and"; items: ParsedFilter[] }
  | { kind: "or"; items: ParsedFilter[] }
  | { kind: "not"; item: ParsedFilter }
  | ParsedCond;

export interface FilterResult {
  filter: ParsedFilter | null;
  /** Relation paths the filter joins through (`author`), for the join limit. */
  joins: Set<string>;
  conditions: number;
  depth: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2})$/;
const MAX_TEXT_VALUE = 1_000;
const OPS: ReadonlySet<string> = new Set(FILTER_OPERATORS);

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;

function invalid(pointer: string, message: string): ItemsApiError {
  return new ItemsApiError("INVALID_FILTER", message, { pointer });
}

function validDate(value: string): boolean {
  if (!DATE.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value);
}

/** Checks one value against the field; returns it unchanged (values are only ever bound parameters). */
function checkScalar(field: ResolvedField, op: FilterOperator, value: unknown, pointer: string): FilterScalar {
  const t = field.type;
  if (op === "contains") {
    if (typeof value !== "string" || !value.length || value.length > MAX_TEXT_VALUE) throw invalid(pointer, "contains takes a non-empty string");
    return value;
  }
  if (field.cls === "relation" || field.cls === "uuid") {
    if (typeof value !== "string" || !UUID.test(value)) throw invalid(pointer, "Expected an id (uuid)");
    return value;
  }
  if (field.cls === "boolean") {
    if (typeof value !== "boolean") throw invalid(pointer, "Expected true or false");
    return value;
  }
  if (t === "number" || t === "integer") {
    if (typeof value !== "number" || !Number.isFinite(value) || (t === "integer" && !Number.isInteger(value))) throw invalid(pointer, `Expected ${t === "integer" ? "an integer" : "a number"}`);
    return value;
  }
  if (t === "date") {
    if (typeof value !== "string" || !validDate(value)) throw invalid(pointer, "Expected a date (YYYY-MM-DD)");
    return value;
  }
  if (t === "datetime") {
    if (typeof value !== "string" || !DATETIME.test(value) || Number.isNaN(Date.parse(value))) throw invalid(pointer, "Expected a date-time with a time zone (ISO 8601)");
    return value;
  }
  if (typeof value !== "string" || value.length > MAX_TEXT_VALUE) throw invalid(pointer, "Expected a string");
  return value;
}

/**
 * Parses the `filter` parameter (URL-decoded JSON) for `model`. Limits: bytes, depth (groups plus
 * relation hops), conditions, group size, `in` size.
 */
export function parseFilter(raw: string | null, model: string, lookup: FieldLookup, limits: ApiLimits): FilterResult {
  const joins = new Set<string>();
  if (raw === null || raw === "") return { filter: null, joins, conditions: 0, depth: 0 };
  if (Buffer.byteLength(raw, "utf8") > limits.filterBytes) throw new ItemsApiError("FILTER_TOO_COMPLEX", `The filter is larger than ${limits.filterBytes} bytes`);
  let input: unknown;
  try {
    input = JSON.parse(raw);
  } catch {
    throw invalid("", "The filter is not valid JSON");
  }
  let conditions = 0;
  let maxDepth = 0;

  const node = (value: unknown, pointer: string, depth: number, current: string, hops: ResolvedField[]): ParsedFilter => {
    if (depth > limits.filterDepth) throw new ItemsApiError("FILTER_TOO_DEEP", `The filter is nested deeper than ${limits.filterDepth} levels`, { pointer });
    maxDepth = Math.max(maxDepth, depth);
    if (!isPlainObject(value)) throw invalid(pointer, "Expected an object");
    const keys = Object.keys(value);
    if (keys.length !== 1) throw invalid(pointer, "Each filter object has exactly one key");
    const key = keys[0];
    const inner = Object.entries(value)[0][1];

    if (!hops.length && (key === "and" || key === "or")) {
      if (!Array.isArray(inner) || !inner.length) throw invalid(`${pointer}/${key}`, `${key} takes a non-empty array`);
      if (inner.length > limits.groupItems) throw new ItemsApiError("FILTER_TOO_COMPLEX", `${key} has more than ${limits.groupItems} items`, { pointer: `${pointer}/${key}` });
      return { kind: key, items: inner.map((item, i) => node(item, `${pointer}/${key}/${i}`, depth + 1, current, hops)) };
    }
    if (!hops.length && key === "not") return { kind: "not", item: node(inner, `${pointer}/not`, depth + 1, current, hops) };

    const field = lookup.field(current, key);
    if (!field) throw unknownField(key, `filter ${pointer || "/"}`);
    const fieldPointer = `${pointer}/${key}`;

    // A to-one relation followed by a field of its target: one hop (counts as depth and a join).
    if (field.cls === "relation" && field.relation && isPlainObject(inner)) {
      const innerKeys = Object.keys(inner);
      if (innerKeys.length === 1 && !OPS.has(innerKeys[0])) {
        if (hops.length) throw invalid(fieldPointer, "A filter can follow one relation only");
        joins.add([...hops, field].map((f) => f.key).join("."));
        return node(inner, fieldPointer, depth + 1, field.relation.target, [...hops, field]);
      }
    }

    const allowed = OPERATORS_BY_CLASS[field.cls];
    if (!allowed.length) throw new ItemsApiError("FIELD_NOT_FILTERABLE", `Field "${key}" cannot be filtered`, { field: key });
    if (!isPlainObject(inner)) throw invalid(fieldPointer, "Expected an operator object, e.g. {\"eq\": ...}");
    const opKeys = Object.keys(inner);
    if (opKeys.length !== 1) throw invalid(fieldPointer, "Each condition has exactly one operator");
    const op = opKeys[0];
    if (!OPS.has(op)) throw invalid(`${fieldPointer}/${op.slice(0, 32)}`, `Unknown operator; use one of ${FILTER_OPERATORS.join(", ")}`);
    if (!allowed.includes(op as FilterOperator)) throw invalid(`${fieldPointer}/${op}`, `Operator ${op} does not apply to field "${key}"; use one of ${allowed.join(", ")}`);
    const raw = Object.entries(inner)[0][1];
    const opPointer = `${fieldPointer}/${op}`;
    conditions += 1;
    if (conditions > limits.filterConditions) throw new ItemsApiError("FILTER_TOO_COMPLEX", `The filter has more than ${limits.filterConditions} conditions`);

    let checked: FilterScalar | FilterScalar[] | boolean;
    if (op === "null") {
      if (typeof raw !== "boolean") throw invalid(opPointer, "null takes true or false");
      checked = raw;
    } else if (op === "in") {
      if (!Array.isArray(raw) || !raw.length) throw invalid(opPointer, "in takes a non-empty array");
      if (raw.length > limits.inValues) throw invalid(opPointer, `in takes at most ${limits.inValues} values`);
      checked = raw.map((item, i) => checkScalar(field, "eq", item, `${opPointer}/${i}`));
    } else {
      checked = checkScalar(field, op as FilterOperator, raw, opPointer);
    }
    return { kind: "cond", path: [...hops, field], model: current, op: op as FilterOperator, value: checked };
  };

  const filter = node(input, "", 0, model, []);
  return { filter, joins, conditions, depth: maxDepth };
}

/** `-publishedAt,title` → sort keys on readable, sortable fields of the model itself. */
export function parseSort(raw: string | null, model: string, lookup: FieldLookup, limits: ApiLimits): Array<SortKey & { resolved: ResolvedField }> {
  if (raw === null || raw.trim() === "") return [];
  const parts = raw.split(",").map((part) => part.trim());
  if (parts.length > limits.sortKeys) throw new ItemsApiError("INVALID_SORT", `Sort takes at most ${limits.sortKeys} keys`);
  const seen = new Set<string>();
  return parts.map((part) => {
    const desc = part.startsWith("-");
    const key = desc ? part.slice(1) : part;
    if (!key) throw new ItemsApiError("INVALID_SORT", "Empty sort key");
    const field = lookup.field(model, key);
    if (!field) throw unknownField(key, "sort");
    if (!isSortableClass(field.cls)) throw new ItemsApiError("INVALID_SORT", `Field "${key}" cannot be sorted on`, { field: key });
    if (seen.has(key)) throw new ItemsApiError("INVALID_SORT", `Field "${key}" appears twice in sort`);
    seen.add(key);
    return { field: key, direction: desc ? "desc" : "asc", resolved: field } as const;
  });
}

export interface ExpandNode {
  field: ResolvedField;
  /** The model the relation points to. */
  target: string;
  children: ExpandNode[];
}

/**
 * `author,author.company` → a tree of relation fields. Each segment must be a relation field the caller
 * can read (otherwise UNKNOWN_FIELD). Whether the TARGET model may be read is decided later: if not,
 * the value stays a bare id, exactly as without expansion.
 */
export function parseExpand(raw: string | null, model: string, lookup: FieldLookup, limits: ApiLimits): { tree: ExpandNode[]; joins: Set<string>; depth: number } {
  const joins = new Set<string>();
  const tree: ExpandNode[] = [];
  if (raw === null || raw.trim() === "") return { tree, joins, depth: 0 };
  let depth = 0;
  const paths = [...new Set(raw.split(",").map((part) => part.trim()).filter(Boolean))];
  if (paths.length > 50) throw new ItemsApiError("INVALID_EXPAND", "Too many expand paths");
  for (const path of paths) {
    const segments = path.split(".");
    if (segments.some((segment) => !segment)) throw new ItemsApiError("INVALID_EXPAND", `Invalid expand path "${path.slice(0, 64)}"`);
    if (segments.length > limits.expandDepth) throw new ItemsApiError("EXPAND_TOO_DEEP", `Expansion is limited to ${limits.expandDepth} levels`);
    depth = Math.max(depth, segments.length);
    let level = tree;
    let current = model;
    const walked: string[] = [];
    for (const segment of segments) {
      const field = lookup.field(current, segment);
      if (!field) throw unknownField(segment, "expand");
      if (field.type !== "relation" || !field.relation) {
        throw new ItemsApiError("INVALID_EXPAND", `Field "${segment}" is not a relation`, { field: segment });
      }
      walked.push(segment);
      joins.add(walked.join("."));
      let child = level.find((n) => n.field.key === segment);
      if (!child) {
        child = { field, target: field.relation.target, children: [] };
        level.push(child);
      }
      level = child.children;
      current = field.relation.target;
    }
  }
  return { tree, joins, depth };
}

/** `fields=title,author`: a sparse output set; every key must be readable. */
export function parseFields(raw: string | null, model: string, lookup: FieldLookup): Set<string> | null {
  if (raw === null || raw.trim() === "") return null;
  const keys = [...new Set(raw.split(",").map((part) => part.trim()).filter(Boolean))];
  if (keys.length > 200) throw new ItemsApiError("INVALID_PARAMETER", "Too many fields requested");
  for (const key of keys) {
    const field = lookup.field(model, key);
    if (!field || field.system) throw unknownField(key, "fields");
  }
  return new Set(keys);
}

/** The join limit: distinct relation paths across filter and expand (sort never joins). */
export function checkJoins(limits: ApiLimits, ...sets: Array<Set<string>>): void {
  const all = new Set(sets.flatMap((set) => [...set]));
  if (all.size > limits.joins) throw new ItemsApiError("TOO_MANY_JOINS", `At most ${limits.joins} joins per request (this one needs ${all.size})`);
}
