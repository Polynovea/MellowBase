import { describe, expect, it } from "vitest";
import { isWorkspaceStorageKey } from "./storageKeys";

const ws = "11111111-1111-1111-1111-111111111111";

describe("isWorkspaceStorageKey", () => {
  it.each([`${ws}/general/1700000000000-abc.png`, `${ws}/blog/covers/x.webp`])("accepts %s", (key) => {
    expect(isWorkspaceStorageKey(ws, key)).toBe(true);
  });

  it.each([
    ["another workspace", "22222222-2222-2222-2222-222222222222/general/a.png"],
    ["a prefix collision", `${ws}0/general/a.png`],
    ["the bare prefix", `${ws}/`],
    ["traversal out of the prefix", `${ws}/../22222222-2222-2222-2222-222222222222/a.png`],
    ["a dot segment", `${ws}/./a.png`],
    ["an empty segment", `${ws}//a.png`],
    ["a backslash", `${ws}/..\\a.png`],
    ["a control character", `${ws}/a\u0000.png`],
    ["a leading slash", `/${ws}/a.png`],
    ["a non-string", 42],
    ["an oversized key", `${ws}/${"a".repeat(2000)}`],
  ])("rejects %s", (_label, key) => {
    expect(isWorkspaceStorageKey(ws, key)).toBe(false);
  });

  it("rejects everything when the workspace is unknown", () => {
    expect(isWorkspaceStorageKey("", "/a.png")).toBe(false);
  });
});
