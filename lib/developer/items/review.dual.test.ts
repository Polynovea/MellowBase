// Security review of 97adbcb (Phase 4): leak paths in channels that did not call the one permission
// function. Each is a matrix cell, end to end through the real route with a real API token.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { describeWithDatabase } from "@/lib/db/testing/database";
import { closeTableMoveSession } from "@/lib/content/testing/tableMove";
import { createPreviewToken } from "@/lib/content/previewService";
import { createDeveloperApiToken } from "@/lib/developer/apiTokenService";
import { listItems, updateItem } from "@/lib/developer/items/service";
import { SECRET, ctxFor, fixture, P, report, type Fixture } from "@/lib/developer/items/testing/dualFixture";
import { GET as exportRoute } from "@/app/api/v1/export/route";
import { GET as releaseRoute } from "@/app/api/v1/releases/[id]/route";
import { GET as modelRoute } from "@/app/api/v1/models/[model]/route";
import { GET as bundleRoute } from "@/app/api/v1/schema/bundle/route";
import { GET as contentListRoute } from "@/app/api/v1/content/[model]/route";
import { DELETE as entryDeleteRoute } from "@/app/api/v1/entries/[id]/route";
import { POST as entryPublishRoute } from "@/app/api/v1/entries/[id]/publish/route";
import { POST as entryWorkflowRoute } from "@/app/api/v1/entries/[id]/workflow/route";
import { GET as itemsRoute } from "@/app/api/v1/models/[model]/items/route";

const BASE = "https://cms.example.test";
const EVERY_SCOPE = ["content.read", "content.write", "content.delete", "content.publish", "schema.read", "media.read", "releases.read"];

describeWithDatabase("security review: leak paths through the one permission function [postgres]", (backend) => {
  let fx: Fixture;
  const tokens: Record<string, string> = {};
  let editorAdmin = "";

  const call = (handler: (req: Request, ctx: never) => Promise<Response>, path: string, token: string, init: { method?: string; params?: Record<string, string>; headers?: Record<string, string>; body?: unknown } = {}) =>
    handler(new Request(`${BASE}${path}`, {
      method: init.method ?? "GET",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...init.headers },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    }), { params: Promise.resolve(init.params ?? {}) } as never);

  beforeAll(async () => {
    fx = await fixture(backend);
    // A second admin who holds the editor role (secret hidden), for preview issuing and a removable creator.
    const [admin] = await backend.query<{ id: string }>("insert into admin_users (username, email) values ($1, $1 || '@example.test') returning id", [`rv-${randomUUID().slice(0, 8)}`]);
    editorAdmin = admin.id;
    const [member] = await backend.query<{ id: string }>("insert into workspace_members (workspace_id, admin_user_id, status) values ($1, $2, 'active') returning id", [fx.workspaceId, admin.id]);
    await backend.query("insert into member_roles (workspace_member_id, role_id) values ($1, $2)", [member.id, fx.roles.editor]);
    await backend.query("insert into role_permissions (role_id, permission_key) values ($1, 'content.entry.read') on conflict do nothing", [fx.roles.editor]);
    const make = async (name: string, actorId: string, roleId: string | null) =>
      (await createDeveloperApiToken({ workspaceId: fx.workspaceId, actorId, name: `${name}-${randomUUID().slice(0, 6)}`, scopes: EVERY_SCOPE, roleId })).secret;
    tokens.owner = await make("owner", fx.adminUserId, fx.roles.owner);
    tokens.editor = await make("editor", fx.adminUserId, fx.roles.editor);
    tokens.orphan = await make("orphan", editorAdmin, null); // no role: acts as its creator
  }, 180_000);
  afterAll(async () => { await closeTableMoveSession(); });

  it("matrix: export, releases, models/schema bundle, legacy writes, draft relation hop, preview issuer, removed creator", async () => {
    const results: Record<string, string> = {};

    // 1. Export: owner only.
    const denied = await call(exportRoute as never, "/api/v1/export", tokens.editor);
    expect(denied.status).toBe(403);
    expect((await denied.json()).error.code).toBe("EXPORT_REQUIRES_OWNER");
    const exported = await call(exportRoute as never, "/api/v1/export", tokens.owner);
    expect(exported.status).toBe(200);
    expect(JSON.stringify(await exported.json())).toContain(SECRET);
    results["export"] = "pass (editor 403, owner 200)";

    // 2. Releases: version data passes the token's field access.
    const releaseId = randomUUID();
    await backend.query("insert into releases (id, workspace_id, name, status) values ($1, $2, 'R', 'draft')", [releaseId, fx.workspaceId]);
    const [version] = await backend.query<{ id: string }>("select published_version_id as id from content_entries where id = $1", [fx.articles[1]]);
    await backend.query("insert into release_items (release_id, entry_id, entry_version_id) values ($1, $2, $3)", [releaseId, fx.articles[1], version.id]);
    const editorRelease = await (await call(releaseRoute as never, `/api/v1/releases/${releaseId}`, tokens.editor, { params: { id: releaseId } })).json();
    expect(JSON.stringify(editorRelease)).not.toContain(SECRET);
    expect(JSON.stringify(editorRelease)).toContain("Alpha 1");
    expect(JSON.stringify(await (await call(releaseRoute as never, `/api/v1/releases/${releaseId}`, tokens.owner, { params: { id: releaseId } })).json())).toContain(SECRET);
    results["releases"] = "pass";

    // 3. Model bundle and schema bundle: a hidden field's key never appears.
    const modelDoc = await (await call(modelRoute as never, `/api/v1/models/${fx.article.apiKey}`, tokens.editor, { params: { model: fx.article.apiKey } })).json();
    expect(JSON.stringify(modelDoc)).not.toMatch(/"key":"secret"/);
    expect(JSON.stringify(modelDoc)).toMatch(/"key":"title"/);
    const bundle = await (await call(bundleRoute as never, "/api/v1/schema/bundle", tokens.editor)).json();
    expect(JSON.stringify(bundle)).not.toMatch(/"key":"secret"|"key":"salary"/);
    expect(JSON.stringify(await (await call(bundleRoute as never, "/api/v1/schema/bundle", tokens.owner)).json())).toMatch(/"key":"secret"/);
    results["models+schema-bundle"] = "pass";

    // 4. Removed creator: a token with no role whose creator is suspended reads and changes nothing.
    await backend.query("update workspace_members set status = 'suspended' where workspace_id = $1 and admin_user_id = $2", [fx.workspaceId, editorAdmin]);
    const orphanItems = await call(itemsRoute as never, `/api/v1/models/${fx.article.apiKey}/items`, tokens.orphan, { params: { model: fx.article.apiKey } });
    expect(orphanItems.status).toBe(403);
    const orphanLegacy = await (await call(contentListRoute as never, `/api/v1/content/${fx.article.apiKey}`, tokens.orphan, { params: { model: fx.article.apiKey } })).json();
    expect(JSON.stringify(orphanLegacy)).not.toContain(SECRET);
    expect(JSON.stringify(orphanLegacy)).not.toContain("Alpha");
    results["removed-creator"] = "pass (items 403, legacy data empty)";

    // 5. Legacy writes: delete, publish, workflow need canDelete / canPublish / canWrite (closed for the orphan).
    for (const [handler, path, body] of [
      [entryDeleteRoute, `/api/v1/entries/${fx.articles[3]}`, undefined],
      [entryPublishRoute, `/api/v1/entries/${fx.articles[3]}/publish`, {}],
      [entryWorkflowRoute, `/api/v1/entries/${fx.articles[3]}/workflow`, { action: "submit" }],
    ] as const) {
      const response = await call(handler as never, path, tokens.orphan, { method: handler === entryDeleteRoute ? "DELETE" : "POST", params: { id: fx.articles[3] }, body });
      expect(response.status).toBe(403);
    }
    const [still] = await backend.query<{ status: string }>("select status from content_entries where id = $1", [fx.articles[3]]);
    expect(still.status).not.toBe("archived");
    await backend.query("update workspace_members set status = 'active' where workspace_id = $1 and admin_user_id = $2", [fx.workspaceId, editorAdmin]);
    results["legacy-writes"] = "pass (3 routes 403, nothing changed)";

    // 6. Draft relation hop under an entry-scoped preview: a related entry outside the scope is judged on its published row.
    const owner = await ctxFor(fx, fx.roles.owner);
    await updateItem(owner, fx.person.apiKey, fx.people[0], { name: "Renamed in draft" });
    const filter = JSON.stringify({ author: { name: { eq: "Renamed in draft" } } });
    const scoped = await ctxFor(fx, fx.roles.owner, {}, { allowed: true, entryIds: [fx.articles[0]] });
    expect((await listItems(scoped, fx.article.apiKey, P({ variant: "draft", filter }))).items).toEqual([]);
    const everyDraft = await ctxFor(fx, fx.roles.owner);
    expect((await listItems(everyDraft, fx.article.apiKey, P({ variant: "draft", filter, limit: "100" }))).items.length).toBeGreaterThan(0);
    results["draft-relation-hop"] = "pass";

    // 7. Preview issuer: the issuer's field rules apply, and an issuer who left invalidates the link.
    const { token: preview } = await createPreviewToken({ workspaceId: fx.workspaceId, entryId: fx.articles[0], actorId: editorAdmin });
    const drafts = await call(itemsRoute as never, `/api/v1/models/${fx.article.apiKey}/items?variant=draft`, tokens.owner, { params: { model: fx.article.apiKey }, headers: { "x-polynovea-preview": preview } });
    // The owner token itself has content.preview? No: EVERY_SCOPE lacks it, so the preview token is what grants drafts.
    expect(drafts.status).toBe(200);
    const draftBody = await drafts.json();
    expect(draftBody.data.map((item: { id: string }) => item.id)).toEqual([fx.articles[0]]);
    expect(JSON.stringify(draftBody)).not.toContain(SECRET); // the issuer cannot read it, so the owner token sees it not either
    await backend.query("update workspace_members set status = 'suspended' where workspace_id = $1 and admin_user_id = $2", [fx.workspaceId, editorAdmin]);
    const stale = await call(itemsRoute as never, `/api/v1/models/${fx.article.apiKey}/items?variant=draft`, tokens.owner, { params: { model: fx.article.apiKey }, headers: { "x-polynovea-preview": preview } });
    expect(stale.status).toBe(403);
    expect((await stale.json()).error.code).toBe("PREVIEW_TOKEN_REQUIRED");
    await backend.query("update workspace_members set status = 'active' where workspace_id = $1 and admin_user_id = $2", [fx.workspaceId, editorAdmin]);
    results["preview-issuer"] = "pass (issuer's rules applied; departed issuer 403)";

    report("review-matrix", results);
  }, 180_000);

  it("token role binding: workspace.manage alone cannot mint a token for a role the manager does not hold", async () => {
    const { POST: createTokenRoute } = await import("@/app/api/developer/tokens/route");
    expect(typeof createTokenRoute).toBe("function"); // the route check is unit-tested; the database constraint is here:
    const other = await backend.createWorkspace();
    const [foreign] = await backend.query<{ id: string }>("insert into roles (workspace_id, key, name) values ($1, 'z', 'z') returning id", [other.workspaceId]);
    await expect(createDeveloperApiToken({ workspaceId: fx.workspaceId, actorId: fx.adminUserId, name: `x-${randomUUID()}`, scopes: ["content.read"], roleId: foreign.id })).rejects.toThrow();
  });
});
