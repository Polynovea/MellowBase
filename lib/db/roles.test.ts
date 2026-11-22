import { describe, expect, it, vi } from "vitest";
import type { ClientBase } from "pg";
import { createHash, createHmac, pbkdf2Sync } from "node:crypto";
import { bootstrapInstallRoles, ensureCompatibilityRoles, scramSha256Verifier } from "@/lib/db/roles.mjs";

function fakeClient(missing: string[], canCreate: boolean, opts: { superuser?: boolean; bypassRoles?: string[]; version?: number } = {}) {
  const statements: string[] = [];
  const query = vi.fn(async (text: string) => {
    statements.push(text);
    if (text.includes("unnest($1::text[])")) return { rows: missing.map((name) => ({ name })) };
    if (text.includes("rolsuper or rolcreaterole or rolcreatedb or rolbypassrls")) return { rows: (opts.bypassRoles ?? []).map((rolname) => ({ rolname })) };
    if (text.includes("rolcreaterole")) return { rows: [{ can_create: canCreate }] };
    if (text.includes("as superuser")) return { rows: [{ superuser: opts.superuser ?? false, member: false, version: opts.version ?? 160000 }] };
    return { rows: [] };
  });
  const escapeLiteral = (value: string) => `'${value.replace(/'/g, "''")}'`;
  return { client: { query, escapeLiteral } as unknown as ClientBase, statements };
}

describe("ensureCompatibilityRoles", () => {
  it("does nothing when every role exists", async () => {
    const { client, statements } = fakeClient([], false);
    await expect(ensureCompatibilityRoles(client)).resolves.toEqual([]);
    expect(statements).toHaveLength(1);
  });

  it("creates the missing roles as NOLOGIN when the login may create roles", async () => {
    const { client, statements } = fakeClient(["postgres"], true);
    await expect(ensureCompatibilityRoles(client)).resolves.toEqual(["postgres"]);
    expect(statements.at(-1)).toContain('create role "postgres" nologin');
  });

  it("tells the operator what to run when the login cannot create roles", async () => {
    const { client } = fakeClient(["anon", "postgres"], false);
    await expect(ensureCompatibilityRoles(client)).rejects.toThrow(
      'missing role(s) anon, postgres that the migrations grant to. Ask the database administrator to run: create role "anon" nologin; create role "postgres" nologin;',
    );
  });
});

describe("bootstrapInstallRoles", () => {
  it("works as a non-superuser admin: names no superuser-only attribute and sends only SCRAM verifiers", async () => {
    const { client, statements } = fakeClient([], true);
    await bootstrapInstallRoles(client, { database: "polynovea", ownerPassword: "o'wner", appPassword: "app" });
    const alters = statements.filter((text) => text.startsWith("alter role"));
    expect(alters).toHaveLength(2);
    for (const text of alters) {
      expect(text).not.toMatch(/superuser|bypassrls/i);
      expect(text).toMatch(/password 'SCRAM-SHA-256\$4096:[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+'$/);
    }
    expect(statements.join("\n")).not.toContain("o''wner");
    // Temporary SET membership in the owner for the schema owner change, revoked straight after.
    const grant = statements.indexOf('grant "polynovea_owner" to current_user with set true, inherit false');
    const alterSchema = statements.indexOf('alter schema public owner to "polynovea_owner"');
    const revoke = statements.indexOf('revoke "polynovea_owner" from current_user');
    expect(grant).toBeGreaterThan(-1);
    expect(alterSchema).toBeGreaterThan(grant);
    expect(revoke).toBeGreaterThan(alterSchema);
    expect(statements).toContain('revoke temporary on database "polynovea" from public');
    expect(statements).toContain("revoke create on schema public from public");
  });

  it("needs no temporary membership as a superuser, and uses the PostgreSQL 15 grant form there", async () => {
    const asSuperuser = fakeClient([], true, { superuser: true });
    await bootstrapInstallRoles(asSuperuser.client, { database: "polynovea", ownerPassword: "a", appPassword: "b" });
    expect(asSuperuser.statements.some((text) => text.startsWith("grant \"polynovea_owner\" to current_user"))).toBe(false);
    const pg15 = fakeClient([], true, { version: 150000 });
    await bootstrapInstallRoles(pg15.client, { database: "polynovea", ownerPassword: "a", appPassword: "b" });
    expect(pg15.statements).toContain('grant "polynovea_owner" to current_user');
  });

  it("refuses to continue when a role holds a bypass attribute", async () => {
    const { client, statements } = fakeClient([], true, { bypassRoles: ["polynovea_app"] });
    await expect(bootstrapInstallRoles(client, { database: "polynovea", ownerPassword: "a", appPassword: "b" })).rejects.toThrow(/polynovea_app hold SUPERUSER, CREATEROLE, CREATEDB or BYPASSRLS/);
    expect(statements.some((text) => text.startsWith("alter schema"))).toBe(false);
  });

  it("refuses a database name that is not a plain identifier", async () => {
    const { client } = fakeClient([], true);
    await expect(bootstrapInstallRoles(client, { database: 'x"; drop', ownerPassword: "a", appPassword: "b" })).rejects.toThrow(/Refusing/);
  });

  it("refuses shared or empty passwords", async () => {
    const { client } = fakeClient([], true);
    await expect(bootstrapInstallRoles(client, { database: "polynovea", ownerPassword: "same", appPassword: "same" })).rejects.toThrow(/share/);
    await expect(bootstrapInstallRoles(client, { database: "polynovea", ownerPassword: "", appPassword: "b" })).rejects.toThrow(/required/);
  });
});

describe("scramSha256Verifier", () => {
  it("matches the RFC 7677 construction PostgreSQL verifies against", () => {
    const salt = Buffer.from("0123456789abcdef");
    const verifier = scramSha256Verifier("pencil", { salt, iterations: 4096 });
    const salted = pbkdf2Sync("pencil", salt, 4096, 32, "sha256");
    const storedKey = createHash("sha256").update(createHmac("sha256", salted).update("Client Key").digest()).digest("base64");
    const serverKey = createHmac("sha256", salted).update("Server Key").digest("base64");
    expect(verifier).toBe(`SCRAM-SHA-256$4096:${salt.toString("base64")}$${storedKey}:${serverKey}`);
    expect(scramSha256Verifier("pencil")).not.toBe(scramSha256Verifier("pencil")); // random salt
  });
});
