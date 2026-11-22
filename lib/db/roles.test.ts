import { describe, expect, it, vi } from "vitest";
import type { ClientBase } from "pg";
import { bootstrapInstallRoles, ensureCompatibilityRoles } from "@/lib/db/roles.mjs";

function fakeClient(missing: string[], canCreate: boolean) {
  const statements: string[] = [];
  const query = vi.fn(async (text: string) => {
    statements.push(text);
    if (text.includes("unnest($1::text[])")) return { rows: missing.map((name) => ({ name })) };
    if (text.includes("rolcreaterole")) return { rows: [{ can_create: canCreate }] };
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
  it("never grants bypass attributes and quotes passwords as literals", async () => {
    const { client, statements } = fakeClient([], true);
    await bootstrapInstallRoles(client, { database: "polynovea", ownerPassword: "o'wner", appPassword: "app" });
    const alters = statements.filter((text) => text.startsWith("alter role"));
    expect(alters).toHaveLength(2);
    for (const text of alters) expect(text).toContain("nosuperuser nocreaterole nocreatedb nobypassrls");
    expect(alters[0]).toContain("password 'o''wner'");
    expect(statements).toContain("revoke create on schema public from public");
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
