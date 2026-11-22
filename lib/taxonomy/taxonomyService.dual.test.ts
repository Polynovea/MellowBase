import { afterAll, describe, expect, it, vi } from "vitest";
import { describeBothBackends, type BackendFixtures } from "@/lib/db/testing/dualBackend";
import type { DataBackend } from "@/lib/db/backend";
import {
  assignVersionTerms,
  createTaxonomy,
  createTerm,
  deleteTaxonomy,
  getTaxonomy,
  getTerm,
  getTermUsage,
  getVersionTerms,
  listTaxonomies,
  listTerms,
  mergeTerms,
  updateTaxonomy,
  updateTerm,
} from "@/lib/taxonomy/taxonomyService";
import { GET as listTaxonomiesRoute, POST as createTaxonomyRoute } from "@/app/api/taxonomies/route";
import { DELETE as deleteTaxonomyRoute, GET as getTaxonomyRoute, PUT as updateTaxonomyRoute } from "@/app/api/taxonomies/[id]/route";
import { GET as listTermsRoute, POST as createTermRoute } from "@/app/api/taxonomies/[id]/terms/route";
import { GET as getTermRoute, PUT as updateTermRoute } from "@/app/api/taxonomies/[id]/terms/[termId]/route";
import { POST as mergeRoute } from "@/app/api/taxonomies/[id]/terms/[termId]/merge/route";
import { GET as usageRoute } from "@/app/api/taxonomies/[id]/terms/[termId]/usage/route";

// Route auth is the admin and platform areas' job (still on Supabase); here it resolves to the
// test workspace so the six taxonomy routes can be exercised end to end on each backend.
const actor = vi.hoisted(() => ({ workspaceId: "", adminUserId: "" }));
vi.mock("@/lib/platform/permissions", () => ({
  requirePlatformAccess: vi.fn(async () => ({ data: { actor: { ...actor }, adminUser: { id: actor.adminUserId } } })),
}));

const TAXONOMY_KEYS = ["created_at", "description", "hierarchical", "id", "model_restrictions", "name", "slug", "updated_at", "workspace_id"];
const TERM_KEYS = ["created_at", "deprecated_by_term_id", "description", "id", "is_deprecated", "metadata_json", "name", "order_index", "parent_term_id", "slug", "taxonomy_id", "updated_at", "workspace_id"];
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?\+00:00$/;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

const sortKeys = (value: unknown): unknown =>
  Array.isArray(value) ? value.map(sortKeys)
  : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, sortKeys(v)]))
  : value;

/** Replaces IDs by first-seen order and timestamps by a marker, so both backends' results compare equal. */
function normalize(value: unknown): unknown {
  const ids = new Map<string, string>();
  return JSON.parse(JSON.stringify(sortKeys(value)), (_key, v) => {
    if (typeof v !== "string") return v;
    if (ISO.test(v)) return "<timestamp>";
    return v.replace(UUID, (id) => {
      if (!ids.has(id)) ids.set(id, `<id${ids.size + 1}>`);
      return ids.get(id)!;
    });
  });
}

const recorded: Partial<Record<DataBackend, Record<string, unknown>>> = {};
const record = (backend: DataBackend, name: string, value: unknown) => {
  recorded[backend] ??= {};
  recorded[backend]![name] = normalize(value);
};

async function seedTerms(backend: BackendFixtures) {
  const { workspaceId, adminUserId } = await backend.createWorkspace();
  const taxonomy = await createTaxonomy({ workspaceId, actorAdminUserId: adminUserId, name: "Topics", slug: "Topics Main", hierarchical: true });
  const parent = await createTerm({
    workspaceId, actorAdminUserId: adminUserId, taxonomyId: taxonomy.id, name: " Science ", slug: "science", orderIndex: 1,
    localizations: [{ locale: "fr", label: "Sciences" }], aliases: [{ alias: " sci " }],
  });
  const child = await createTerm({ workspaceId, actorAdminUserId: adminUserId, taxonomyId: taxonomy.id, parentTermId: parent.id, name: "Physics", slug: "physics" });
  const sibling = await createTerm({ workspaceId, actorAdminUserId: adminUserId, taxonomyId: taxonomy.id, name: "Arts", slug: "arts", orderIndex: 0 });
  return { workspaceId, adminUserId, taxonomy, parent, child, sibling };
}

describeBothBackends("taxonomy", "taxonomy service", (backend) => {
  it("creates, lists, reads, updates and deletes taxonomies with identical shapes", async () => {
    const { workspaceId, adminUserId } = await backend.createWorkspace();
    const created = await createTaxonomy({ workspaceId, actorAdminUserId: adminUserId, name: "  Regions ", slug: "World Regions!", description: " Where ", modelRestrictions: ["article"] });
    expect(Object.keys(created).sort()).toEqual(TAXONOMY_KEYS);
    expect(created).toMatchObject({ name: "Regions", slug: "world-regions-", description: "Where", hierarchical: false, model_restrictions: ["article"], workspace_id: workspaceId });
    expect(created.created_at).toMatch(ISO);

    await createTaxonomy({ workspaceId, actorAdminUserId: adminUserId, name: "Audiences", slug: "audiences", modelRestrictions: [] });
    const list = await listTaxonomies(workspaceId);
    expect(list.map((t) => t.name)).toEqual(["Audiences", "Regions"]);
    expect(list[0].model_restrictions).toBeNull();

    expect(await getTaxonomy(workspaceId, created.id)).toEqual(created);
    const updated = await updateTaxonomy({ workspaceId, actorAdminUserId: adminUserId, id: created.id, name: "Areas", description: null });
    expect(updated).toMatchObject({ id: created.id, name: "Areas", description: null, slug: "world-regions-" });
    expect(updated.updated_at).toMatch(ISO);

    expect(await deleteTaxonomy({ workspaceId, actorAdminUserId: adminUserId, id: created.id })).toEqual({ ok: true });
    expect(await getTaxonomy(workspaceId, created.id)).toBeNull();
    record(backend.name, "taxonomy lifecycle", { created, list, updated });
  });

  it("writes an audit event and a webhook delivery for each change", async () => {
    const { workspaceId, adminUserId } = await backend.createWorkspace();
    const [subscription] = await backend.query<{ id: string }>(
      "insert into webhook_subscriptions (workspace_id, name, endpoint_url, event_filters, signing_secret_hash, signing_secret_encrypted) values ($1, 'test', 'https://hooks.example.test/x', '{taxonomy.created}', 'h', 'e') returning id",
      [workspaceId],
    );
    const created = await createTaxonomy({ workspaceId, actorAdminUserId: adminUserId, name: "Audited", slug: "audited" });
    const events = await backend.query<{ action: string; entity_id: string }>(
      "select action, entity_id from platform_audit_events where workspace_id = $1 and entity_type = 'taxonomy'",
      [workspaceId],
    );
    expect(events).toEqual([{ action: "taxonomy.created", entity_id: created.id }]);
    const deliveries = await backend.query<{ event_type: string }>("select event_type from webhook_deliveries where subscription_id = $1", [subscription.id]);
    expect(deliveries).toEqual([{ event_type: "taxonomy.created" }]);
  });

  it("keeps workspaces isolated", async () => {
    const a = await backend.createWorkspace();
    const b = await backend.createWorkspace();
    const taxonomy = await createTaxonomy({ workspaceId: a.workspaceId, actorAdminUserId: a.adminUserId, name: "Private", slug: "private" });
    expect(await listTaxonomies(b.workspaceId)).toEqual([]);
    expect(await getTaxonomy(b.workspaceId, taxonomy.id)).toBeNull();
    await expect(updateTaxonomy({ workspaceId: b.workspaceId, actorAdminUserId: b.adminUserId, id: taxonomy.id, name: "Stolen" })).rejects.toThrow();
    await deleteTaxonomy({ workspaceId: b.workspaceId, actorAdminUserId: b.adminUserId, id: taxonomy.id });
    expect((await getTaxonomy(a.workspaceId, taxonomy.id))?.name).toBe("Private");
  });

  it("rejects a duplicate slug", async () => {
    const { workspaceId, adminUserId } = await backend.createWorkspace();
    await createTaxonomy({ workspaceId, actorAdminUserId: adminUserId, name: "Tags", slug: "tags" });
    await expect(createTaxonomy({ workspaceId, actorAdminUserId: adminUserId, name: "Tags 2", slug: "tags" })).rejects.toThrow();
  });

  it("builds the term tree with localizations and aliases", async () => {
    const { workspaceId, taxonomy, parent, child, sibling } = await seedTerms(backend);
    expect(Object.keys(parent).filter((k) => !["localizations", "aliases"].includes(k)).sort()).toEqual(TERM_KEYS);
    expect(parent).toMatchObject({ name: "Science", slug: "science", order_index: 1, is_deprecated: false, metadata_json: {} });
    expect(parent.localizations).toEqual([expect.objectContaining({ locale: "fr", label: "Sciences", description: null, term_id: parent.id })]);
    expect(parent.aliases).toEqual([expect.objectContaining({ alias: "sci", locale: null, term_id: parent.id })]);

    const tree = await listTerms(workspaceId, taxonomy.id);
    expect(tree.map((t) => t.id)).toEqual([sibling.id, parent.id]);
    expect(tree[1].children?.map((t) => t.id)).toEqual([child.id]);
    expect(tree[1].localizations).toHaveLength(1);
    expect(tree[1].aliases).toHaveLength(1);
    record(backend.name, "term tree", tree);
  });

  it("updates a term and replaces its localizations and aliases", async () => {
    const { workspaceId, adminUserId, parent, child } = await seedTerms(backend);
    const updated = await updateTerm({
      workspaceId, actorAdminUserId: adminUserId, termId: child.id, name: "Applied Physics", parentTermId: null, orderIndex: 5,
      localizations: [{ locale: "de", label: "Physik", description: "Naturwissenschaft" }], aliases: [],
    });
    expect(updated).toMatchObject({ name: "Applied Physics", parent_term_id: null, order_index: 5, aliases: [] });
    expect(updated.localizations).toEqual([expect.objectContaining({ locale: "de", label: "Physik" })]);

    const untouched = await updateTerm({ workspaceId, actorAdminUserId: adminUserId, termId: parent.id, description: "All sciences" });
    expect(untouched.localizations).toHaveLength(1);
    expect(untouched.aliases).toHaveLength(1);
    expect(await getTerm(workspaceId, child.id)).toEqual(updated);
    record(backend.name, "term update", { updated, untouched });
  });

  it("merges terms through the SQL function and refuses invalid merges", async () => {
    const { workspaceId, adminUserId, parent, sibling } = await seedTerms(backend);
    const result = await mergeTerms({ workspaceId, actorAdminUserId: adminUserId, sourceTermId: parent.id, targetTermId: sibling.id });
    expect(result).toEqual({ ok: true, sourceTermId: parent.id, targetTermId: sibling.id });
    const source = await getTerm(workspaceId, parent.id);
    expect(source).toMatchObject({ is_deprecated: true, deprecated_by_term_id: sibling.id });
    const target = await getTerm(workspaceId, sibling.id);
    expect(target?.aliases?.map((a) => a.alias).sort()).toEqual(["Science", "sci"]);

    await expect(mergeTerms({ workspaceId, actorAdminUserId: adminUserId, sourceTermId: sibling.id, targetTermId: sibling.id })).rejects.toThrow("Cannot merge a term into itself");

    const other = await createTaxonomy({ workspaceId, actorAdminUserId: adminUserId, name: "Other", slug: "other" });
    const foreign = await createTerm({ workspaceId, actorAdminUserId: adminUserId, taxonomyId: other.id, name: "Foreign", slug: "foreign" });
    await expect(mergeTerms({ workspaceId, actorAdminUserId: adminUserId, sourceTermId: foreign.id, targetTermId: sibling.id })).rejects.toThrow("Cannot merge terms from different taxonomies");
    record(backend.name, "merge", { result, source, target });
  });

  it("assigns terms to a version and reports usage", async () => {
    const { workspaceId, parent, child } = await seedTerms(backend);
    const { entryId, versionIds } = await backend.createEntry(workspaceId, 2);
    await assignVersionTerms({ workspaceId, entryId, versionId: versionIds[0], termIds: [parent.id, child.id] });
    await assignVersionTerms({ workspaceId, entryId, versionId: versionIds[1], termIds: [parent.id] });

    const versionTerms = await getVersionTerms(workspaceId, versionIds[0]);
    expect(versionTerms.map((t) => t.id).sort()).toEqual([parent.id, child.id].sort());
    expect(Object.keys(versionTerms[0]).sort()).toEqual(TERM_KEYS);

    const usage = await getTermUsage(workspaceId, parent.id);
    expect(usage.usageCount).toBe(2);
    expect(usage.entries.map((e) => e.versionId).sort()).toEqual([...versionIds].sort());

    await assignVersionTerms({ workspaceId, entryId, versionId: versionIds[0], termIds: [] });
    expect(await getVersionTerms(workspaceId, versionIds[0])).toEqual([]);
    expect((await getTermUsage(workspaceId, child.id)).usageCount).toBe(0);
    record(backend.name, "usage", { usage: { ...usage, entries: [...usage.entries].sort((a, b) => a.versionId.localeCompare(b.versionId)) }, versionTerms: [...versionTerms].sort((a, b) => a.name.localeCompare(b.name)) });
  });

  it("serves the six taxonomy routes with the same envelope and safe errors", async () => {
    const { workspaceId, adminUserId } = await backend.createWorkspace();
    Object.assign(actor, { workspaceId, adminUserId });
    const json = async (response: Response) => ({ status: response.status, body: await response.json() });
    const req = (body?: unknown) => new Request("http://cms.test/api", body === undefined ? {} : { method: "POST", body: JSON.stringify(body) });
    const params = <T,>(value: T) => ({ params: Promise.resolve(value) });

    const created = await json(await createTaxonomyRoute(req({ name: "Topics", slug: "topics" })));
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ success: true, error: null, data: { name: "Topics" } });
    const id = created.body.data.id as string;

    expect((await json(await createTaxonomyRoute(req({ name: "No slug" }))))).toMatchObject({ status: 400, body: { error: "Name and slug are required" } });
    expect((await json(await listTaxonomiesRoute(req())))).toMatchObject({ status: 200, body: { data: [{ id }] } });
    expect((await json(await getTaxonomyRoute(req(), params({ id }))))).toMatchObject({ status: 200, body: { data: { id } } });
    expect((await json(await getTaxonomyRoute(req(), params({ id: "00000000-0000-0000-0000-000000000000" }))))).toMatchObject({ status: 404 });
    expect((await json(await updateTaxonomyRoute(req({ name: "Subjects" }), params({ id }))))).toMatchObject({ status: 200, body: { data: { name: "Subjects" } } });

    const term = await json(await createTermRoute(req({ name: "Maths", slug: "maths" }), params({ id })));
    expect(term.status).toBe(201);
    const termId = term.body.data.id as string;
    const other = await json(await createTermRoute(req({ name: "Logic", slug: "logic" }), params({ id })));
    expect((await json(await listTermsRoute(req(), params({ id }))))).toMatchObject({ status: 200, body: { data: [{ name: "Logic" }, { name: "Maths" }] } });
    expect((await json(await getTermRoute(req(), params({ id, termId }))))).toMatchObject({ status: 200, body: { data: { id: termId } } });
    expect((await json(await updateTermRoute(req({ description: "Numbers" }), params({ id, termId }))))).toMatchObject({ status: 200, body: { data: { description: "Numbers" } } });
    expect((await json(await usageRoute(req(), params({ id, termId }))))).toMatchObject({ status: 200, body: { data: { termId, usageCount: 0, entries: [] } } });
    expect((await json(await mergeRoute(req({ targetTermId: other.body.data.id }), params({ id, termId }))))).toMatchObject({ status: 200, body: { data: { ok: true } } });

    // A malformed ID in a read is "not found", as it was over PostgREST.
    expect((await json(await getTaxonomyRoute(req(), params({ id: "not-a-uuid" }))))).toMatchObject({ status: 404 });
    expect((await json(await getTermRoute(req(), params({ id, termId: "not-a-uuid" }))))).toMatchObject({ status: 404 });
    expect((await json(await usageRoute(req(), params({ id, termId: "not-a-uuid" }))))).toMatchObject({ status: 200, body: { data: { usageCount: 0 } } });
    expect((await json(await listTermsRoute(req(), params({ id: "not-a-uuid" }))))).toMatchObject({ status: 200, body: { data: [] } });

    // Database errors (duplicate slug, malformed ID in a write) reach the caller only as the route's fallback text.
    for (const response of [
      await createTermRoute(req({ name: "Maths again", slug: "maths" }), params({ id })),
      await updateTaxonomyRoute(req({ name: "x" }), params({ id: "not-a-uuid" })),
      await deleteTaxonomyRoute(req(), params({ id: "not-a-uuid" })),
      await mergeRoute(req({ targetTermId: "not-a-uuid" }), params({ id, termId })),
    ]) {
      const { status, body } = await json(response);
      expect(status).toBeGreaterThanOrEqual(400);
      expect(body.error).not.toMatch(/duplicate key|violates|invalid input syntax|relation "|SQLSTATE|PGRST/i);
    }

    expect((await json(await deleteTaxonomyRoute(req(), params({ id }))))).toMatchObject({ status: 200, body: { data: { ok: true } } });
  });
});

describe("taxonomy backends agree", () => {
  afterAll(() => vi.restoreAllMocks());
  it("returns identical shapes and values on supabase and postgres", () => {
    expect(recorded.supabase).toBeDefined();
    expect(recorded.postgres).toEqual(recorded.supabase);
  });
});
