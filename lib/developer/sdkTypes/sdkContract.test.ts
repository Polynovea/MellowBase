import { describe, expect, it } from "vitest";
import * as server from "@/lib/developer/items/types";
import { SCHEMA_CHANGE_HEADER, SCHEMA_FIELDS_HEADER } from "@/lib/developer/sdkTypes/drift";
import * as sdk from "@/packages/cms-sdk/src/contract";

describe("SDK wire contract matches the server's", () => {
  it("error codes, operators, headers and limits are identical", () => {
    expect(sdk.ITEM_ERROR_CODES).toEqual(server.ITEM_ERROR_CODES);
    expect(sdk.FILTER_OPERATORS).toEqual(server.FILTER_OPERATORS);
    expect(sdk.HARD_LIMITS).toEqual(server.HARD_LIMITS);
    expect(sdk.ITEMS_API_PREFIX).toBe(server.ITEMS_API_PREFIX);
    expect(sdk.SCHEMA_HASH_HEADER).toBe(server.SCHEMA_HASH_HEADER);
    expect(sdk.PREVIEW_TOKEN_HEADER).toBe(server.PREVIEW_TOKEN_HEADER);
    expect(sdk.SCHEMA_CHANGE_HEADER).toBe(SCHEMA_CHANGE_HEADER);
    expect(sdk.SCHEMA_FIELDS_HEADER).toBe(SCHEMA_FIELDS_HEADER);
  });

  it("builds the same paths for ordinary keys", () => {
    expect(sdk.itemsPath("article")).toBe(server.itemsPath("article"));
    expect(sdk.itemPath("article", "0b6e")).toBe(server.itemPath("article", "0b6e"));
  });
});
