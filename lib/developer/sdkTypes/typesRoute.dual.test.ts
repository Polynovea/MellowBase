// /api/v1/types.ts on real PostgreSQL (Phase 4, wave 2): a real API token (with a role that cannot read
// `secret` or `salary`) pulls its types file through the real route, auth and loader; the headers are
// per caller; and `polynovea-cms types pull` / `--check` work against it over HTTP on loopback.
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { describeWithDatabase } from "@/lib/db/testing/database";
import { createModel } from "@/lib/schema/modelService";
import { uniqueKey } from "@/lib/schema/engine/testing";
import { createDeveloperApiToken } from "@/lib/developer/apiTokenService";
import type { FieldDefinition } from "@/lib/schema/fields/types";
import { PRIVATE_HEADERS } from "@/lib/developer/items/http";
import { GET } from "@/app/api/v1/types.ts/route";

const f = (key: string, type: FieldDefinition["type"], extra: Partial<FieldDefinition> = {}): FieldDefinition =>
  ({ key, label: key, type, required: false, localized: false, unique: false, ...extra } as FieldDefinition);
const report = (label: string, value: unknown) => console.log(`[types-dual] ${label} ${JSON.stringify(value)}`);
const call = (secret: string) => GET(new Request("http://cms.test/api/v1/types.ts", { headers: { authorization: `Bearer ${secret}` } }));

describeWithDatabase("GET /api/v1/types.ts [postgres]", (backend) => {
  let workspaceId: string;
  let adminUserId: string;
  let articleKey: string;
  let personKey: string;
  let editorSecret: string;
  let ownerSecret: string;
  let readOnlySecret: string;

  beforeAll(async () => {
    ({ workspaceId, adminUserId } = await backend.createWorkspace());
    const [member] = await backend.query<{ id: string }>("insert into workspace_members (workspace_id, admin_user_id, status) values ($1, $2, 'active') returning id", [workspaceId, adminUserId]);
    const [owner] = await backend.query<{ id: string }>("insert into roles (workspace_id, key, name) values ($1, 'owner', 'owner') returning id", [workspaceId]);
    const [editor] = await backend.query<{ id: string }>("insert into roles (workspace_id, key, name) values ($1, 'editor', 'editor') returning id", [workspaceId]);
    await backend.query("insert into member_roles (workspace_member_id, role_id) values ($1, $2)", [member.id, owner.id]);
    for (const role of [owner.id, editor.id]) {
      await backend.query("insert into role_permissions (role_id, permission_key) values ($1, 'content.entry.read') on conflict do nothing", [role]);
    }
    personKey = uniqueKey("person");
    articleKey = uniqueKey("article");
    const person = await createModel({ workspaceId, createdBy: adminUserId, proposedSchema: { name: "Person", apiKey: personKey, fields: [f("name", "text", { required: true }), f("salary", "integer")] } });
    if (!person.ok) throw new Error(person.error);
    const article = await createModel({ workspaceId, createdBy: adminUserId, proposedSchema: { name: "Article", apiKey: articleKey, fields: [
      f("title", "text", { required: true }), f("secret", "text"), f("rating", "integer"),
      f("author", "relation", { relation: { targetModelApiKey: personKey, cardinality: "many_to_one", onDelete: "remove_reference" } }),
    ] } });
    if (!article.ok) throw new Error(article.error);
    const rule = (modelId: string, field: string) =>
      backend.query("insert into content_field_permissions (workspace_id, content_model_id, field_key, role_id, can_read, can_write) values ($1, $2, $3, $4, false, false)", [workspaceId, modelId, field, editor.id]);
    await rule(article.data.model.id, "secret");
    await rule(person.data.model.id, "salary");

    const scopes = ["schema.read", "content.read"];
    editorSecret = (await createDeveloperApiToken({ workspaceId, actorId: adminUserId, name: "site (editor)", scopes, roleId: editor.id, rateLimitPerMinute: 600 })).secret;
    ownerSecret = (await createDeveloperApiToken({ workspaceId, actorId: adminUserId, name: "owner", scopes, rateLimitPerMinute: 600 })).secret;
    readOnlySecret = (await createDeveloperApiToken({ workspaceId, actorId: adminUserId, name: "content only", scopes: ["content.read"], rateLimitPerMinute: 600 })).secret;
  }, 120_000);

  it("a real token gets its own types file: hidden fields absent, private headers", async () => {
    const res = await call(editorSecret);
    expect(res.status).toBe(200);
    const headers = Object.fromEntries(["content-type", "cache-control", "vary", "x-content-type-options"].map((name) => [name, res.headers.get(name)]));
    report("headers", headers);
    expect(headers).toEqual({ "content-type": "text/plain; charset=utf-8", "cache-control": "private, no-store", vary: PRIVATE_HEADERS.vary, "x-content-type-options": "nosniff" });
    const hash = res.headers.get("x-polynovea-schema-hash");
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    const body = await res.text();
    expect(body.split("\n")[0]).toBe(`// schema-hash: ${hash}`);
    expect(body.split("\n")[1]).toMatch(/^\/\/ generated-at: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(body).toContain(`\n  ${articleKey}: {\n`);
    expect(body).toContain(`\n  ${personKey}: {\n`);
    expect(body).toMatch(/title\?: string;/);
    expect(body).toMatch(/author\?: string \| \w+Item;/);
    expect(body).not.toMatch(/secret/);
    expect(body).not.toMatch(/salary/);
    report("editor file", { bytes: body.length, models: (body.match(/hash: "[0-9a-f]{64}", fields/g) ?? []).length });
  });

  it("is per caller: the owner's token sees the fields the editor's cannot", async () => {
    const owner = await (await call(ownerSecret)).text();
    expect(owner).toMatch(/secret\?: string;/);
    expect(owner).toMatch(/salary\?: number;/);
    const editor = await (await call(editorSecret)).text();
    expect(owner.replace(/^\/\/ generated-at: .*$/m, "")).not.toBe(editor.replace(/^\/\/ generated-at: .*$/m, ""));
  });

  it("refuses a bad token (401) and a token without schema.read (403)", async () => {
    expect((await call("pnv_not-a-real-token")).status).toBe(401);
    const denied = await call(readOnlySecret);
    expect(denied.status).toBe(403);
    expect(await denied.text()).not.toMatch(/secret|salary/);
  });

  describe("polynovea-cms types pull against the live route", () => {
    let server: Server;
    let base: string;
    let dir: string;
    beforeAll(async () => {
      dir = mkdtempSync(join(tmpdir(), "pnv-types-dual-"));
      server = createServer(async (req, res) => {
        const response = await GET(new Request(`${base}${req.url}`, { headers: req.headers as Record<string, string> }));
        res.writeHead(response.status, Object.fromEntries(response.headers));
        res.end(await response.text());
      });
      await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });
    afterAll(async () => {
      await new Promise((done) => server.close(done));
      rmSync(dir, { recursive: true, force: true });
    });

    const cli = (args: string[]) => new Promise<{ code: number | null; output: string }>((done) => {
      const child = spawn(process.execPath, [resolve("packages/cms-cli/bin/polynovea-cms.mjs"), "types", "pull", "--url", base, "--out", join(dir, "polynovea-cms.ts"), ...args], { env: { ...process.env, POLYNOVEA_CMS_TOKEN: editorSecret } });
      let output = "";
      child.stdout.on("data", (d) => (output += d));
      child.stderr.on("data", (d) => (output += d));
      child.on("close", (code) => done({ code, output }));
    });

    it("pull writes the file; --check is 0 when current and 1 after a model is added", async () => {
      const pulled = await cli([]);
      report("pull", pulled);
      expect(pulled.code).toBe(0);
      const file = readFileSync(join(dir, "polynovea-cms.ts"), "utf8");
      expect(file).not.toMatch(/secret|salary/);
      expect(file).not.toContain(editorSecret);

      const current = await cli(["--check"]);
      report("check current", current);
      expect(current.code).toBe(0);

      const extra = await createModel({ workspaceId, createdBy: adminUserId, proposedSchema: { name: "Tag", apiKey: uniqueKey("tag"), fields: [f("label", "text")] } });
      if (!extra.ok) throw new Error(extra.error);
      const drifted = await cli(["--check"]);
      report("check after a new model", drifted);
      expect(drifted.code).toBe(1);
      expect(drifted.output).toMatch(/\+ tag/);
      expect(drifted.output).not.toContain(editorSecret);
    }, 60_000);
  });
});
