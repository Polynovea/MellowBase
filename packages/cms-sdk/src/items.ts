/**
 * Typed client for the generated items API: `cms.items("article").list({ filter, sort })`.
 *
 * Types come from the file `polynovea-cms types pull` writes (its `Models` interface). Without it,
 * everything still works, loosely typed.
 */
import {
  HARD_LIMITS,
  PREVIEW_TOKEN_HEADER,
  SCHEMA_HASH_HEADER,
  itemPath,
  itemsPath,
  type FilterInput,
  type ItemListMeta,
  type ItemMeta,
  type ItemRecord,
  type Variant,
} from "./contract.js";
import { SchemaDriftMonitor } from "./drift.js";
import { PolynoveaItemsError } from "./errors.js";

/** What a generated `Models` entry provides for one model. */
export interface ModelTypes {
  data: object;
  create: object;
  patch: object;
  filter: unknown;
  sort: string;
  expand: string;
}

/** A model without generated types. */
export interface LooseModel {
  data: Record<string, unknown>;
  create: Record<string, unknown>;
  patch: Record<string, unknown>;
  filter: FilterInput;
  sort: string;
  expand: string;
}
export type LooseModels = Record<string, LooseModel>;
export type ModelMap<M> = { [K in keyof M]: ModelTypes };

/** One to three sort keys (the API's limit); `-key` sorts descending. */
export type SortSpec<K extends string> = K | readonly [K] | readonly [K, K] | readonly [K, K, K];

export interface RequestOptions {
  signal?: AbortSignal;
  requestId?: string;
  /** Overrides the client's preview token for this call. */
  preview?: string;
}

export interface GetParams<T extends ModelTypes> extends RequestOptions {
  expand?: readonly T["expand"][];
  fields?: readonly (keyof T["data"] & string)[];
  locale?: string;
  /** `draft` needs a preview token or a token with the content.preview scope. */
  variant?: Variant;
}

export interface ListParams<T extends ModelTypes> extends GetParams<T> {
  filter?: T["filter"];
  sort?: SortSpec<T["sort"]>;
  /** Case-insensitive text search over readable text fields, 2–200 characters. */
  search?: string;
  /** 1–100, default 25. */
  limit?: number;
  /** `meta.page.nextCursor` of the previous page. */
  cursor?: string | null;
}

export interface ItemList<TData> {
  data: Array<ItemRecord<TData>>;
  meta: ItemListMeta;
}
export interface ItemResult<TData> {
  data: ItemRecord<TData>;
  meta: ItemMeta;
}

export interface ItemsTransport {
  baseUrl: string;
  token: string;
  preview?: string;
  fetch: typeof fetch;
  drift: SchemaDriftMonitor;
}

const list = (values: readonly string[] | undefined) => (values && values.length ? values.join(",") : undefined);

export class ItemsClient<T extends ModelTypes = LooseModel> {
  constructor(private readonly transport: ItemsTransport, readonly model: string) {}

  /** One page. `meta.page.nextCursor` is null on the last page. */
  list(params: ListParams<T> = {}): Promise<ItemList<T["data"]>> {
    const query = new URLSearchParams();
    if (params.filter !== undefined) query.set("filter", JSON.stringify(params.filter));
    const sort = params.sort === undefined ? undefined : typeof params.sort === "string" ? [params.sort] : [...(params.sort as readonly string[])];
    if (sort?.length) query.set("sort", sort.join(","));
    if (params.search !== undefined) query.set("search", params.search);
    if (params.limit !== undefined) query.set("limit", String(params.limit));
    if (params.cursor) query.set("cursor", params.cursor);
    this.common(query, params);
    return this.request<ItemList<T["data"]>>("GET", itemsPath(this.model), query, undefined, params);
  }

  /** Every item, following `nextCursor` page by page. */
  async *all(params: Omit<ListParams<T>, "cursor"> = {}): AsyncGenerator<ItemRecord<T["data"]>, void, undefined> {
    let cursor: string | null = null;
    do {
      const page: ItemList<T["data"]> = await this.list({ ...params, cursor, limit: params.limit ?? HARD_LIMITS.pageSize } as ListParams<T>);
      for (const item of page.data) yield item;
      cursor = page.meta.page.nextCursor;
    } while (cursor);
  }

  get(id: string, params: GetParams<T> = {}): Promise<ItemResult<T["data"]>> {
    const query = new URLSearchParams();
    this.common(query, params);
    return this.request<ItemResult<T["data"]>>("GET", itemPath(this.model, id), query, undefined, params);
  }

  /** Creates a draft (never publishes). Only writable fields; unknown fields are rejected by the API. */
  create(body: T["create"], options: RequestOptions = {}): Promise<ItemResult<T["data"]>> {
    return this.request<ItemResult<T["data"]>>("POST", itemsPath(this.model), undefined, body, options);
  }

  /** A new draft version with the given fields merged in. */
  update(id: string, patch: T["patch"], options: RequestOptions = {}): Promise<ItemResult<T["data"]>> {
    return this.request<ItemResult<T["data"]>>("PATCH", itemPath(this.model, id), undefined, patch, options);
  }

  async delete(id: string, options: RequestOptions = {}): Promise<void> {
    await this.request<void>("DELETE", itemPath(this.model, id), undefined, undefined, options);
  }

  private common(query: URLSearchParams, params: GetParams<T>) {
    const expand = list(params.expand as readonly string[] | undefined);
    if (expand) query.set("expand", expand);
    const fields = list(params.fields as readonly string[] | undefined);
    if (fields) query.set("fields", fields);
    if (params.locale) query.set("locale", params.locale);
    if (params.variant) query.set("variant", params.variant);
  }

  private async request<R>(method: string, path: string, query: URLSearchParams | undefined, body: unknown, options: RequestOptions): Promise<R> {
    const { transport } = this;
    const headers = new Headers({ authorization: `Bearer ${transport.token}`, accept: "application/json" });
    const preview = options.preview ?? transport.preview;
    if (preview) headers.set(PREVIEW_TOKEN_HEADER, preview);
    const hash = transport.drift.requestHash(this.model);
    if (hash) headers.set(SCHEMA_HASH_HEADER, hash);
    if (options.requestId) headers.set("x-request-id", options.requestId);
    if (body !== undefined) headers.set("content-type", "application/json");
    const qs = query?.toString();

    let response: Response;
    try {
      response = await transport.fetch(`${transport.baseUrl}${path}${qs ? `?${qs}` : ""}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: options.signal,
      });
    } catch (error) {
      if ((error as { name?: string })?.name === "AbortError") throw error;
      throw new PolynoveaItemsError(0, "NETWORK_ERROR", `Could not reach the CMS: ${error instanceof Error ? error.message : String(error)}`);
    }

    const payload = response.status === 204 ? null : await response.json().catch(() => null);
    if (!response.ok) {
      try {
        transport.drift.check(this.model, response.headers);
      } catch {
        // strict mode: the API error below is the more useful one; the drift error comes on the next success
      }
      const err = (payload as { error?: { code?: unknown; message?: unknown; details?: unknown } } | null)?.error ?? {};
      const retry = Number(response.headers.get("retry-after"));
      throw new PolynoveaItemsError(
        response.status,
        typeof err.code === "string" ? err.code : "HTTP_ERROR",
        typeof err.message === "string" ? err.message : response.statusText || `HTTP ${response.status}`,
        err.details,
        (payload as { meta?: { requestId?: string } } | null)?.meta?.requestId ?? response.headers.get("x-request-id") ?? undefined,
        Number.isFinite(retry) && retry > 0 ? retry : undefined,
      );
    }
    transport.drift.check(this.model, response.headers);
    return payload as R;
  }
}
