import { describe, expect, it } from "vitest";
import { decideModelAccess } from "@/lib/developer/items/access";
import { ItemsApiError } from "@/lib/developer/items/errors";
import { legacyWriteData, sanitiseLegacyPayload, type TokenAccesses } from "@/lib/developer/items/legacy";
import { ARTICLE, PERSON, ROLE, RULES, tokenPrincipal } from "@/lib/developer/items/testing/principals";

function accessesFor(roleId: string, roleKey: string): TokenAccesses {
  const principal = tokenPrincipal({ roleIds: [roleId], roleKeys: [roleKey] });
  const list = [decideModelAccess(principal, ARTICLE, RULES), decideModelAccess(principal, PERSON, RULES)];
  return { byId: new Map(list.map((a) => [a.model.id, a])), byKey: new Map(list.map((a) => [a.model.apiKey, a])) };
}
const editor = accessesFor(ROLE.editor, "editor");

describe("legacy developer routes: one sanitiser", () => {
  it("published records (model api key) and entry rows (content_model_id) lose hidden fields", () => {
    expect(sanitiseLegacyPayload([{ id: "1", model: "article", data: { title: "T", secret: "S" } }], editor)).toEqual([{ id: "1", model: "article", data: { title: "T" } }]);
    const rows = [{ id: "e", content_model_id: ARTICLE.id, currentVersion: { id: "v", data_jsonb: { title: "T", secret: "S" } } }];
    expect(sanitiseLegacyPayload(rows, editor)[0].currentVersion.data_jsonb).toEqual({ title: "T" });
  });

  it("entry views ({entry, model, versions}) and create results ({entry, version}) too", () => {
    const view = { entry: { id: "e", content_model_id: PERSON.id }, model: { id: PERSON.id, apiKey: "person" }, versions: [{ data_jsonb: { name: "N", salary: 1 } }] };
    expect(sanitiseLegacyPayload(view, editor).versions[0].data_jsonb).toEqual({ name: "N" });
    const created = { entry: { id: "e", content_model_id: ARTICLE.id }, version: { data_jsonb: { title: "T", secret: "S" } } };
    expect(sanitiseLegacyPayload(created, editor).version.data_jsonb).toEqual({ title: "T" });
  });

  it("data of an unknown or unreadable model becomes empty", () => {
    expect(sanitiseLegacyPayload({ model: "ghost", data: { a: 1 } }, editor)).toEqual({ model: "ghost", data: {} });
    expect(sanitiseLegacyPayload({ content_model_id: "x", currentVersion: { data_jsonb: { a: 1 } } }, editor).currentVersion.data_jsonb).toEqual({});
  });

  it("writes: only writable fields, everything else kept as stored; hidden or read-only keys are refused", () => {
    const writer = accessesFor(ROLE.writer, "writer").byKey.get("article")!;
    expect(legacyWriteData(writer, { rating: 4 }, { title: "Old", secret: "keep", rating: 1, body: { x: 1 } }, false)).toEqual({ title: "Old", secret: "keep", rating: 4 });
    expect(() => legacyWriteData(writer, { secret: "x" }, {}, false)).toThrow(ItemsApiError);
    expect(() => legacyWriteData(writer, { title: "x" }, {}, false)).toThrow(/cannot change/);
    expect(() => legacyWriteData(writer, { rating: 1 }, null, true)).toThrow(/requires fields/);
  });
});

describe("security review: releases and schema documents", async () => {
  const { filterSchemaBundle } = await import("@/lib/developer/items/legacy");
  it("release items take their model from content_entries", () => {
    const release = { id: "r", release_items: [{ content_entries: { id: "e", content_model_id: ARTICLE.id }, content_entry_versions: { data_jsonb: { title: "T", secret: "S" } } }] };
    expect(sanitiseLegacyPayload(release, editor).release_items[0].content_entry_versions.data_jsonb).toEqual({ title: "T" });
  });

  it("schema bundles drop hidden fields and unreadable models", () => {
    const bundle = { format: "b", models: [
      { apiKey: "article", schema: { name: "A", fields: [{ key: "title" }, { key: "secret" }] } },
      { apiKey: "ghost", schema: { name: "G", fields: [{ key: "x" }] } },
    ] };
    const filtered = filterSchemaBundle(bundle, editor);
    expect(filtered.models.map((m) => m.apiKey)).toEqual(["article"]);
    expect(filtered.models[0].schema.fields.map((field) => field.key)).toEqual(["title"]);
  });
});
