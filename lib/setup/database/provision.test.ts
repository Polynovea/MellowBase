import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import type { LookupAddress } from "node:dns";
import type pg from "pg";
import { MANAGED_DATABASE_CA_BUNDLE_ID } from "./caBundles";
import { localEndpoint, type DatabaseEndpoint, type DatabaseLogin } from "./connect";
import { DatabaseSetupError } from "./errors";
import { runManagedDatabaseSetup } from "./flow";
import { MigrationLockError } from "./migrate";
import { ALREADY_INSTALLED, FOREIGN_DATABASE, generateRolePassword, provisionDatabase, type ProvisionedDatabase } from "./provision";
import { setupEventStream, type SetupEvent } from "./stream";
import { adminRoutes, fakeClient, ownerRoutes, type FakeClient } from "./testFakes";

const ADMIN_PASSWORD = "Adm1n-S3cret-Pa55word!";
const PEM = "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----";
const REMOTE: DatabaseEndpoint = { kind: "remote", hostname: "mydb.abc.eu-west-1.rds.amazonaws.com", address: "10.0.4.7", port: 5432, ca: [PEM], caBundleId: MANAGED_DATABASE_CA_BUNDLE_ID };

let logged: MockInstance;
beforeEach(() => { logged = vi.spyOn(console, "error").mockImplementation(() => {}); });
afterEach(() => logged.mockRestore());

function setup(options: { state?: Parameters<typeof adminRoutes>[0]; problems?: Parameters<typeof ownerRoutes>[0]; migrate?: () => Promise<unknown> } = {}) {
  const order: string[] = [];
  const admin = fakeClient(adminRoutes(options.state));
  const originalEnd = admin.client.end.bind(admin.client);
  (admin.client as unknown as { end: () => Promise<void> }).end = async () => { order.push("admin-end"); await originalEnd(); };
  const logins: { endpoint: DatabaseEndpoint; login: DatabaseLogin; fake: FakeClient }[] = [];
  const openClient = vi.fn(async (endpoint: DatabaseEndpoint, _database: string, login: DatabaseLogin) => {
    order.push(`open-${login.user}`);
    const fake = fakeClient(ownerRoutes(options.problems));
    logins.push({ endpoint, login, fake });
    return fake.client;
  });
  const migrate = vi.fn(async (_client: pg.Client, migrateOptions: { emit: (event: SetupEvent & { type: "migration" }) => void }) => {
    order.push("migrate");
    if (options.migrate) await options.migrate();
    migrateOptions.emit({ type: "migration", filename: "0001_init.sql", index: 1, total: 1, status: "applied" });
    return { applied: ["0001_init.sql"], skipped: [] };
  });
  let counter = 0;
  const generatePassword = () => `generated-role-password-${++counter}-${"x".repeat(20)}`;
  const events: SetupEvent[] = [];
  return { admin, openClient, migrate, generatePassword, events, order, logins, deps: { openClient, migrate, generatePassword } };
}

describe("provisionDatabase", () => {
  it("creates the roles with SCRAM verifiers, closes the admin login, then migrates and verifies as the owner", async () => {
    const s = setup();
    const result = await provisionDatabase({ adminClient: s.admin.client, endpoint: REMOTE, database: "postgres", mode: "managed", emit: (e) => s.events.push(e) }, s.deps);

    expect(s.order).toEqual(["admin-end", "open-polynovea_owner", "migrate", "open-polynovea_app"]);
    expect(s.admin.statements.filter((sql) => sql.startsWith("alter role"))).toHaveLength(2);
    // The generated passwords reach the server only as SCRAM verifiers.
    const sent = JSON.stringify([s.admin.statements, s.admin.params]);
    expect(sent).not.toContain("generated-role-password");
    expect(sent).toMatch(/SCRAM-SHA-256\$4096:/);
    expect(s.logins[0].fake.statements).toContain("revoke create on schema public from public");
    expect(s.logins[1].fake.statements).toEqual(["select 1"]);
    expect(result).toEqual({
      databaseMode: "managed",
      database: { host: REMOTE.kind === "remote" ? REMOTE.hostname : "", port: 5432, name: "postgres", caBundleId: MANAGED_DATABASE_CA_BUNDLE_ID },
      roles: { owner: { user: "polynovea_owner", password: "generated-role-password-1-xxxxxxxxxxxxxxxxxxxx" }, app: { user: "polynovea_app", password: "generated-role-password-2-xxxxxxxxxxxxxxxxxxxx" } },
    } satisfies ProvisionedDatabase);
    expect(JSON.stringify(s.events)).not.toContain("generated-role-password");
    for (const login of s.logins) expect(login.fake.ended()).toBe(true);
  });

  it("refuses a database whose installation row exists, before touching any role", async () => {
    const s = setup({ state: { ledger: true, installation: true, installed: true } });
    const error = await provisionDatabase({ adminClient: s.admin.client, endpoint: REMOTE, database: "postgres", mode: "managed", emit: (e) => s.events.push(e) }, s.deps).then(() => new Error("did not fail"), (e: Error) => e);
    expect(error).toBeInstanceOf(DatabaseSetupError);
    expect(error.message).toBe(ALREADY_INSTALLED);
    expect(s.admin.statements.some((sql) => /alter role|create role|grant connect/.test(sql))).toBe(false);
    // It read the row as the table owner (row-level security hides it from the admin), then gave the role back.
    const statements = s.admin.statements;
    expect(statements.indexOf('set role "polynovea_owner"')).toBeLessThan(statements.findIndex((sql) => sql.includes("from public.installation")));
    expect(statements).toContain("reset role");
    expect(statements.at(-1)).toBe('revoke "polynovea_owner" from current_user');
    expect(s.admin.ended()).toBe(true);
    expect(s.openClient).not.toHaveBeenCalled();
  });

  it("refuses Polynovea tables without our ledger", async () => {
    const s = setup({ state: { core: true } });
    const error = await provisionDatabase({ adminClient: s.admin.client, endpoint: REMOTE, database: "postgres", mode: "managed", emit: () => {} }, s.deps).then(() => new Error("did not fail"), (e: Error) => e);
    expect(error.message).toBe(FOREIGN_DATABASE);
  });

  it("resumes a database with our ledger and no installation row", async () => {
    const s = setup({ state: { ledger: true, installation: true, installed: false } });
    await expect(provisionDatabase({ adminClient: s.admin.client, endpoint: REMOTE, database: "postgres", mode: "managed", emit: () => {} }, s.deps)).resolves.toMatchObject({ databaseMode: "managed" });
    expect(s.migrate).toHaveBeenCalledTimes(1);
  });

  it("stops when the app role can create something or a table lacks its policy", async () => {
    const s = setup({ problems: { schemas: ["public"], missingPolicy: ["posts"] } });
    const error = await provisionDatabase({ adminClient: s.admin.client, endpoint: REMOTE, database: "postgres", mode: "managed", emit: (e) => s.events.push(e) }, s.deps).then(() => new Error("did not fail"), (e: Error) => e);
    expect(error).toBeInstanceOf(DatabaseSetupError);
    expect(error.message).toMatch(/more rights than it should have/);
    expect(s.events.at(-1)).toMatchObject({ type: "step", id: "verify", status: "failed" });
    // The details go to the server log, not the browser.
    expect(error.message).not.toContain("posts");
    expect(JSON.stringify(logged.mock.calls)).toContain("posts");
  });

  it("turns a concurrent run into a plain message", async () => {
    const s = setup({ migrate: async () => { throw new MigrationLockError("held"); } });
    const error = await provisionDatabase({ adminClient: s.admin.client, endpoint: REMOTE, database: "postgres", mode: "managed", emit: () => {} }, s.deps).then(() => new Error("did not fail"), (e: Error) => e);
    expect(error.message).toMatch(/Another setup or upgrade is already preparing this database/);
  });

  it("saves the bundled server as 127.0.0.1 with no CA bundle", async () => {
    const s = setup();
    const result = await provisionDatabase({ adminClient: s.admin.client, endpoint: localEndpoint("127.0.0.1", 5433), database: "polynovea", mode: "local", emit: () => {} }, s.deps);
    expect(result.database).toEqual({ host: "127.0.0.1", port: 5433, name: "polynovea", caBundleId: null });
  });

  it("generates 32-byte random passwords", () => {
    const password = generateRolePassword();
    expect(Buffer.from(password, "base64url")).toHaveLength(32);
    expect(generateRolePassword()).not.toBe(password);
  });
});

describe("runManagedDatabaseSetup through the stream (acceptance test 6, unit level)", () => {
  const dns = (_host: string, cb: (e: NodeJS.ErrnoException | null, a: LookupAddress[]) => void) => cb(null, [{ address: "10.0.4.7", family: 4 }]);

  async function run(options: { saveFails?: boolean; loginFails?: boolean } = {}) {
    const s = setup();
    const held: string[] = [];
    const saved: ProvisionedDatabase[] = [];
    const body = { hostname: "mydb.abc.eu-west-1.rds.amazonaws.com", port: 5432, database: "postgres", user: "dbadmin", password: ADMIN_PASSWORD };
    const factory = (config: pg.ClientConfig) => {
      const fake = fakeClient([[/rds_superuser/, () => ({ rows: [{ can: true }] })], [/server_version_num/, () => ({ rows: [{ v: "160004" }] })], ...adminRoutes()], config);
      if (options.loginFails) (fake.client as unknown as { connect: () => Promise<void> }).connect = async () => { throw Object.assign(new Error(`auth failed for ${ADMIN_PASSWORD}`), { code: "28P01" }); };
      s.admin.statements.push(...fake.statements);
      return fake.client;
    };
    const response = setupEventStream(async (emit) => void await runManagedDatabaseSetup(body, {
      emit,
      held,
      saveConfig: async (result) => {
        if (options.saveFails) throw new Error("disk full");
        saved.push(result);
      },
      checks: { resolve: dns, tcp: async () => {}, tls: async () => {}, factory, roots: { id: MANAGED_DATABASE_CA_BUNDLE_ID, ca: [PEM], providers: { rds: true, azure: true } } },
      provision: s.deps,
    }), { secrets: () => held });
    const text = await response.text();
    return { text, saved, held, body, response };
  }

  it("streams every check, step and migration, saves once at the end, and never carries the admin password", async () => {
    const { text, saved, held, body, response } = await run();
    expect(response.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
    const events = text.trim().split("\n\n").map((chunk) => JSON.parse(chunk.split("\n")[1].slice(6)) as SetupEvent);
    expect(events.filter((e) => e.type === "check" && e.status === "passed").map((e) => (e as { id: string }).id)).toEqual(["dns", "tcp", "tls", "login", "version"]);
    expect(events.some((e) => e.type === "migration")).toBe(true);
    expect(events.at(-1)).toEqual({ type: "done", databaseMode: "managed" });
    expect(saved).toHaveLength(1);
    expect(text).not.toContain(ADMIN_PASSWORD);
    expect(JSON.stringify(saved)).not.toContain(ADMIN_PASSWORD);
    expect(JSON.stringify(logged.mock.calls)).not.toContain(ADMIN_PASSWORD);
    expect(held).toEqual([]);
    expect(body.password).toBe("");
  });

  it("saves nothing when a step fails, and the error event is plain", async () => {
    const { text, saved, held } = await run({ loginFails: true });
    expect(saved).toEqual([]);
    expect(text).toMatch(/event: error\ndata: \{"type":"error","message":"The admin username or password was not accepted/);
    expect(text).not.toContain(ADMIN_PASSWORD);
    expect(JSON.stringify(logged.mock.calls)).not.toContain(ADMIN_PASSWORD);
    expect(held).toEqual([]);
  });

  it("reports a failed save without internals", async () => {
    const { text } = await run({ saveFails: true });
    expect(text).toMatch(/"message":"The database step failed unexpectedly \(ref [0-9a-f]{8}\)"/);
    expect(text).not.toContain("disk full");
  });
});
