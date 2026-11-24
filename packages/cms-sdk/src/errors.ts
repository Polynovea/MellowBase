import type { ItemErrorCode } from "./contract.js";

export class PolynoveaCmsError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown, public requestId?: string) {
    super(message);
    this.name = "PolynoveaCmsError";
  }
}

/** An items API error. `code` is one of the API's error codes, or NETWORK_ERROR / HTTP_ERROR / another auth code. */
export class PolynoveaItemsError extends PolynoveaCmsError {
  declare code: ItemErrorCode | "NETWORK_ERROR" | "HTTP_ERROR" | (string & {});
  constructor(status: number, code: string, message: string, details?: unknown, requestId?: string, public retryAfter?: number) {
    super(status, code, message, details, requestId);
    this.name = "PolynoveaItemsError";
  }
}
