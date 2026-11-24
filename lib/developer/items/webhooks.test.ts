import { describe, expect, it } from "vitest";
import { decideModelAccess } from "@/lib/developer/items/access";
import { carriesFieldData, payloadModel, webhookMetadataFor, webhookPayloadFor } from "@/lib/developer/items/webhooks";
import { ARTICLE, RULES, tokenPrincipal } from "@/lib/developer/items/testing/principals";

const editor = decideModelAccess(tokenPrincipal({ kind: "webhook", scopes: new Set(["content.entry.read"]) }), ARTICLE, RULES);

describe("webhook payloads: the one permission function, per subscription", () => {
  it("today's id-only payloads pass untouched, without a query", async () => {
    const payload = { entityType: "content_entry", entityId: "e", metadata: { model: "article", versionId: "v" } };
    expect(carriesFieldData(payload.metadata)).toBe(false);
    expect(await webhookPayloadFor({} as never, "ws", "admin", payload)).toBe(payload);
  });

  it("field data is sanitised for the owner; field lists keep only readable keys", () => {
    const meta = { model: "article", data: { title: "T", secret: "S" }, before: { secret: "old" }, changedFields: ["title", "secret"], versionId: "v" };
    expect(payloadModel(meta)).toBe("article");
    expect(webhookMetadataFor(meta, editor)).toEqual({ model: "article", data: { title: "T" }, before: {}, changedFields: ["title"], versionId: "v" });
  });

  it("without an owner's access (no owner, unknown model) field keys are dropped entirely", async () => {
    const meta = { model: "article", data: { title: "T" }, fields: ["title"], versionId: "v" };
    expect(webhookMetadataFor(meta, null)).toEqual({ model: "article", versionId: "v" });
    const noModel = { entityType: "x", metadata: { data: { a: 1 } } };
    expect(await webhookPayloadFor({} as never, "ws", null, noModel)).toEqual({ entityType: "x", metadata: {} });
  });
});
