import { describe, expect, it, vi } from "vitest";
import { describeWithDatabase } from "@/lib/db/testing/database";
import { ISO_TIMESTAMP } from "@/lib/db/testing/http";
import { requireDeveloperApi } from "@/lib/developer/apiAuth";
import { createDeveloperApiToken, listDeveloperApiTokens, resolveDeveloperApiToken, revokeDeveloperApiToken } from "@/lib/developer/apiTokenService";
const TOKEN_KEYS = ["allowed_models", "created_at", "expires_at", "id", "name", "rate_limit_per_minute", "scopes", "token_prefix"];

const call = (secret: string | null, path = "/api/v1/entries", method = "GET") =>
  new Request(`http://cms.test${path}`, { method, headers: secret ? { authorization: `Bearer ${secret}`, "x-request-id": "req-1" } : {} });

describeWithDatabase("developer API tokens and API authentication", (backend) => {
  it("creates, lists, resolves and revokes tokens with identical shapes; stores only the hash", async () => {
    const { workspaceId, adminUserId } = await backend.createWorkspace();
    const { token, secret } = await createDeveloperApiToken({ workspaceId, actorId: adminUserId, name: " CI ", scopes: ["content.read", "content.read", "schema.read"], allowedModels: [" blog ", ""], rateLimitPerMinute: 60 });
    expect(Object.keys(token).sort()).toEqual(TOKEN_KEYS);
    expect(token).toMatchObject({ name: "CI", scopes: ["content.read", "schema.read"], allowed_models: ["blog"], rate_limit_per_minute: 60, expires_at: null });
    expect(token.created_at).toMatch(ISO_TIMESTAMP);
    expect(secret).toMatch(/^pnv_[A-Za-z0-9_-]{43}$/);
    expect(token.token_prefix).toBe(secret.slice(0, 12));
    const [stored] = await backend.query<{ token_hash: string }>("select token_hash from developer_api_tokens where id = $1", [token.id]);
    expect(stored.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored.token_hash).not.toContain(secret.slice(4));

    expect((await listDeveloperApiTokens(workspaceId)).map((t) => t.id)).toEqual([token.id]);
    expect(await resolveDeveloperApiToken(secret)).toMatchObject({ id: token.id, workspace_id: workspaceId, revoked_at: null });
    expect(await resolveDeveloperApiToken("pnv_not-a-real-token")).toBeNull();

    const revoked = await revokeDeveloperApiToken({ workspaceId, actorId: adminUserId, tokenId: token.id });
    expect(revoked).toMatchObject({ id: token.id, name: "CI" });
    expect(revoked.revoked_at).toMatch(ISO_TIMESTAMP);
    expect(await revokeDeveloperApiToken({ workspaceId, actorId: adminUserId, tokenId: token.id })).toMatchObject({ id: token.id }); // idempotent
    const events = await backend.query<{ action: string }>("select action from platform_audit_events where workspace_id = $1 and entity_type = 'developer_api_token' order by action", [workspaceId]);
    expect(events.map((e) => e.action)).toEqual(["developer.api_token.created", "developer.api_token.revoked"]);
  });

  it("refuses invalid scopes, rate limits and expiry dates before writing anything", async () => {
    const { workspaceId, adminUserId } = await backend.createWorkspace();
    await expect(createDeveloperApiToken({ workspaceId, actorId: adminUserId, name: "x", scopes: ["root"] })).rejects.toThrow("Unsupported API token scope(s): root");
    await expect(createDeveloperApiToken({ workspaceId, actorId: adminUserId, name: "x", scopes: [] })).rejects.toThrow("At least one API scope");
    await expect(createDeveloperApiToken({ workspaceId, actorId: adminUserId, name: "x", scopes: ["content.read"], rateLimitPerMinute: 0 })).rejects.toThrow("Rate limit");
    await expect(createDeveloperApiToken({ workspaceId, actorId: adminUserId, name: "x", scopes: ["content.read"], expiresAt: "soon" })).rejects.toThrow("expiry");
    expect(await listDeveloperApiTokens(workspaceId)).toEqual([]);
  });

  it("authenticates a request: scope, model, revocation, expiry and the per-minute limit", async () => {
    const { workspaceId, adminUserId } = await backend.createWorkspace();
    const { token, secret } = await createDeveloperApiToken({ workspaceId, actorId: adminUserId, name: "Reader", scopes: ["content.read"], allowedModels: ["blog"], rateLimitPerMinute: 3 });

    const ok = await requireDeveloperApi(call(secret), { scope: "content.read", modelApiKey: "blog" });
    expect(ok.data).toMatchObject({ requestId: "req-1", workspaceId, tokenId: token.id, actorAdminUserId: adminUserId, scopes: ["content.read"], allowedModels: ["blog"] });
    expect(ok.data?.rateLimit).toMatchObject({ limit: 3, remaining: 2 });
    expect((await requireDeveloperApi(call(secret), { scope: "content.write" })).error?.status).toBe(403);
    expect((await requireDeveloperApi(call(secret), { scope: "content.read", modelApiKey: "pages" })).error?.status).toBe(403);
    // Three requests are used up: the fourth is limited.
    const limited = await requireDeveloperApi(call(secret), { scope: "content.read" });
    expect(limited.error?.status).toBe(429);

    expect((await requireDeveloperApi(call(null), { scope: "content.read" })).error?.status).toBe(401);
    expect((await requireDeveloperApi(call("not_a_pnv_token"), { scope: "content.read" })).error?.status).toBe(401);
    expect((await requireDeveloperApi(call("pnv_unknown"), { scope: "content.read" })).error?.status).toBe(401);

    const expiring = await createDeveloperApiToken({ workspaceId, actorId: adminUserId, name: "Old", scopes: ["content.read"], expiresAt: "2020-01-01T00:00:00Z" });
    const expired = await requireDeveloperApi(call(expiring.secret), { scope: "content.read" });
    expect(await expired.error?.json()).toMatchObject({ error: { code: "TOKEN_EXPIRED" } });

    await revokeDeveloperApiToken({ workspaceId, actorId: adminUserId, tokenId: token.id });
    const revoked = await requireDeveloperApi(call(secret), { scope: "content.read" });
    expect(revoked.error?.status).toBe(401);
    expect(await revoked.error?.json()).toMatchObject({ error: { code: "TOKEN_REVOKED" } });

    // Last use is recorded in the background.
    await vi.waitFor(async () => {
      const [row] = await backend.query<{ last_used_at: string | null }>("select last_used_at from developer_api_tokens where id = $1", [token.id]);
      expect(row.last_used_at).not.toBeNull();
    });
  });

  it("keeps workspaces isolated", async () => {
    const a = await backend.createWorkspace();
    const b = await backend.createWorkspace();
    const { token, secret } = await createDeveloperApiToken({ workspaceId: a.workspaceId, actorId: a.adminUserId, name: "A", scopes: ["content.read"] });
    expect(await listDeveloperApiTokens(b.workspaceId)).toEqual([]);
    await expect(revokeDeveloperApiToken({ workspaceId: b.workspaceId, actorId: b.adminUserId, tokenId: token.id })).rejects.toThrow("API token not found");
    await expect(revokeDeveloperApiToken({ workspaceId: a.workspaceId, actorId: a.adminUserId, tokenId: "not-a-uuid" })).rejects.toThrow();
    // A token always authenticates into its own workspace.
    expect((await requireDeveloperApi(call(secret), { scope: "content.read" })).data?.workspaceId).toBe(a.workspaceId);
  });
});
