import { describe, expect, it } from "vitest";
import { platformPatch } from "@/lib/http/platformInput";

describe("platformPatch", () => {
  it("keeps only the editable columns", () => {
    expect(platformPatch({ id: "x", created_at: "now", name: " X ", for_ads: true, sort_order: 3, extra: 1 })).toEqual({ ok: true, patch: { name: "X", for_ads: true, sort_order: 3 } });
    expect(platformPatch({})).toEqual({ ok: true, patch: {} });
  });

  it("refuses values of the wrong type", () => {
    expect(platformPatch(null)).toMatchObject({ ok: false });
    expect(platformPatch([])).toMatchObject({ ok: false });
    expect(platformPatch({ name: " " })).toEqual({ ok: false, error: "Name must be a non-empty string" });
    expect(platformPatch({ is_active: "yes" })).toEqual({ ok: false, error: "is_active must be true or false" });
    expect(platformPatch({ sort_order: 1.5 })).toMatchObject({ ok: false });
    expect(platformPatch({ sort_order: -1 })).toMatchObject({ ok: false });
  });
});
