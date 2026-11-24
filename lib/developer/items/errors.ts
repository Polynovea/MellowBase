import type { ItemErrorCode } from "@/lib/developer/items/types";

const STATUS: Record<ItemErrorCode, number> = {
  AUTH_REQUIRED: 401,
  INVALID_TOKEN: 401,
  INSUFFICIENT_SCOPE: 403,
  MODEL_RESTRICTED: 403,
  MODEL_NOT_FOUND: 404,
  ITEM_NOT_FOUND: 404,
  UNKNOWN_FIELD: 400,
  INVALID_FILTER: 400,
  INVALID_SORT: 400,
  INVALID_EXPAND: 400,
  INVALID_PARAMETER: 400,
  INVALID_CURSOR: 400,
  FILTER_TOO_DEEP: 400,
  FILTER_TOO_COMPLEX: 400,
  EXPAND_TOO_DEEP: 400,
  TOO_MANY_JOINS: 400,
  PAGE_TOO_LARGE: 400,
  FIELD_NOT_FILTERABLE: 400,
  FIELD_READ_ONLY: 403,
  REQUIRED_FIELD_NOT_WRITABLE: 422,
  VALIDATION_FAILED: 422,
  PREVIEW_TOKEN_REQUIRED: 403,
  MODEL_TABLE_NOT_READY: 503,
  QUERY_TIMEOUT: 503,
  RATE_LIMITED: 429,
  ITEMS_UNAVAILABLE: 503,
};

/** An expected refusal with a stable code; its message is safe to show to the caller. */
export class ItemsApiError extends Error {
  readonly status: number;
  constructor(readonly code: ItemErrorCode, message: string, readonly details?: unknown) {
    super(message);
    this.name = "ItemsApiError";
    this.status = STATUS[code];
  }
}

/**
 * The one answer for a field that does not exist AND for one the caller cannot read, in every
 * channel: same code, same message, same details shape. The name echoed back is the caller's own input.
 */
export function unknownField(name: string, where: string): ItemsApiError {
  return new ItemsApiError("UNKNOWN_FIELD", `Unknown field "${name.slice(0, 64)}"`, { field: name.slice(0, 64), where });
}
