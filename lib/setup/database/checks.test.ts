import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import type { LookupAddress } from "node:dns";
import type pg from "pg";
import { isClientSafeError } from "@/lib/http/clientError";
import { MANAGED_DATABASE_CA_BUNDLE_ID, type TrustedRoots } from "./caBundles";
import {
  CANNOT_CREATE_ROLES,
  dnsFix,
  loginFix,
  parseManagedDatabaseInput,
  parseServerVersionNum,
  ProbeError,
  runDatabaseChecks,
  tcpFix,
  tlsFix,
  versionFix,
  type CheckEvent,
  type ManagedDatabaseInput,
} from "./checks";
import { DatabaseSetupError } from "./errors";
import { fakeClient, type FakeClient } from "./testFakes";

const PEM = "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----";
const ROOTS: TrustedRoots = { id: MANAGED_DATABASE_CA_BUNDLE_ID, ca: [PEM], providers: { rds: true, azure: true } };
const PASSWORD = "Adm1n-S3cret-Pa55word!";
const HOST = "mydb.abc123.eu-west-1.rds.amazonaws.com";

const input = (overrides: Partial<ManagedDatabaseInput> = {}): ManagedDatabaseInput => ({ hostname: HOST, port: 5432, database: "postgres", user: "dbadmin", password: PASSWORD, ...overrides });
const dns = (addresses: string[]) => (_host: string, cb: (e: NodeJS.ErrnoException | null, a: LookupAddress[]) => void) =>
  cb(null, addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 })));

function harness(options: { addresses?: string[]; tcp?: Error; tls?: Error; login?: Error; canCreate?: boolean; version?: unknown } = {}) {
  const events: CheckEvent[] = [];
  const clients: FakeClient[] = [];
  const tcp = vi.fn(async () => { if (options.tcp) throw options.tcp; });
  const tls = vi.fn(async () => { if (options.tls) throw options.tls; });
  const factory = (config: pg.ClientConfig) => {
    const fake = fakeClient([
      [/rds_superuser/, () => ({ rows: [{ can: options.canCreate ?? true }] })],
      [/server_version_num/, () => ({ rows: [{ v: options.version ?? "160004" }] })],
    ], config);
    if (options.login) (fake.client as unknown as { connect: () => Promise<void> }).connect = async () => { throw options.login; };
    clients.push(fake);
    return fake.client;
  };
  const context = { emit: (event: CheckEvent) => events.push(event), roots: ROOTS, resolve: dns(options.addresses ?? ["10.0.4.7"]), tcp, tls, factory };
  return { events, clients, tcp, tls, context };
}

let logged: MockInstance;
beforeEach(() => { logged = vi.spyOn(console, "error").mockImplementation(() => {}); });
afterEach(() => logged.mockRestore());

function everythingSaid(events: unknown[], extra: unknown[] = []) {
  return JSON.stringify(events) + JSON.stringify(logged.mock.calls) + JSON.stringify(extra);
}

describe("parseManagedDatabaseInput", () => {
  it("accepts the form and a string port", () => {
    expect(parseManagedDatabaseInput({ hostname: ` ${HOST} `, port: "5432", database: "polynovea", user: "postgres", password: " pw " }))
      .toEqual({ hostname: HOST, port: 5432, database: "polynovea", user: "postgres", password: " pw " });
  });

  it.each([
    [{ port: 70000 }, /port/],
    [{ database: "Bad-Name" }, /database name/],
    [{ user: "a b" }, /username/],
    [{ password: "" }, /password/],
    [{ password: "x\u0000y" }, /password/],
    [{ hostname: "" }, /endpoint/],
  ])("refuses %j without echoing it", (patch, message) => {
    const error = (() => { try { parseManagedDatabaseInput({ ...input(), ...patch }); } catch (e) { return e as Error; } return null; })();
    expect(error).toBeInstanceOf(DatabaseSetupError);
    expect(error?.message).toMatch(message);
    expect(error?.message).not.toContain(PASSWORD);
  });
});

describe("runDatabaseChecks", () => {
  it("runs the five checks in order and connects to the pinned IP with verify-full on the real hostname", async () => {
    const h = harness();
    const passed = await runDatabaseChecks(input(), h.context);
    expect(h.events.map((e) => `${e.id}:${e.status}`)).toEqual([
      "dns:running", "dns:passed", "tcp:running", "tcp:passed", "tls:running", "tls:passed", "login:running", "login:passed", "version:running", "version:passed",
    ]);
    expect(h.tcp).toHaveBeenCalledWith("10.0.4.7", 5432, 5_000);
    expect(h.tls).toHaveBeenCalledWith(expect.objectContaining({ address: "10.0.4.7", hostname: HOST, ca: [PEM] }), 10_000);
    const config = h.clients[0].config!;
    expect(config.host).toBe("10.0.4.7");
    expect(config).not.toHaveProperty("connectionString");
    expect(config.ssl).toEqual({ rejectUnauthorized: true, servername: HOST, ca: [PEM], minVersion: "TLSv1.2" });
    expect(passed.serverVersionNum).toBe(160004);
    expect(passed.endpoint).toMatchObject({ kind: "remote", caBundleId: MANAGED_DATABASE_CA_BUNDLE_ID });
    // The connected client no longer holds the password.
    const held = passed.adminClient as unknown as { password: unknown; connectionParameters: { password: unknown } };
    expect(held.password).toBeNull();
    expect(held.connectionParameters.password).toBeNull();
  });

  it("stops at DNS for a private address on a name that is not a managed database", async () => {
    const h = harness();
    const error = await runDatabaseChecks(input({ hostname: "db.example.com" }), h.context).then(() => new Error("did not fail"), (e: Error) => e);
    expect(error).toBeInstanceOf(DatabaseSetupError);
    expect(error.message).toContain("POLYNOVEA_SETUP_DB_ALLOWLIST");
    expect(h.events.at(-1)).toMatchObject({ id: "dns", status: "failed" });
    expect(h.tcp).not.toHaveBeenCalled();
  });

  it.each([
    ["tcp", { tcp: new ProbeError("ETIMEDOUT") }, /security group or network rules/],
    ["tcp", { tcp: new ProbeError("ECONNREFUSED") }, /Nothing answered on port 5432/],
    ["tls", { tls: new ProbeError("ENOTLS") }, /does not accept encrypted connections/],
    ["tls", { tls: new ProbeError("ERR_TLS_CERT_ALTNAME_INVALID") }, /doesn't match the name you entered/],
    ["tls", { tls: new ProbeError("SELF_SIGNED_CERT_IN_CHAIN") }, /couldn't verify the database's identity/],
    ["login", { login: Object.assign(new Error(`password authentication failed for user "dbadmin" ${PASSWORD}`), { code: "28P01" }) }, /username or password was not accepted/],
    ["login", { login: Object.assign(new Error("no pg_hba.conf entry"), { code: "28000" }) }, /refused a login from this server/],
    ["login", { login: Object.assign(new Error("database \"x\" does not exist"), { code: "3D000" }) }, /no database with that name/],
    ["login", { canCreate: false }, /can't create database users/],
    ["version", { version: "140010" }, /PostgreSQL 14\. Polynovea CMS needs version 15/],
    ["version", { version: "PostgreSQL 99; drop table x" }, /couldn't read the database's PostgreSQL version/],
  ] as const)("a %s failure becomes a plain fix", async (id, options, fix) => {
    const h = harness(options as Parameters<typeof harness>[0]);
    const error = await runDatabaseChecks(input(), h.context).then(() => new Error("did not fail"), (e: Error) => e);
    expect(error).toBeInstanceOf(DatabaseSetupError);
    expect(error.message).toMatch(fix);
    expect(isClientSafeError(error)).toBe(true);
    expect(h.events.at(-1)).toMatchObject({ id, status: "failed", message: error.message });
    // Raw driver text never reaches the browser; the password reaches nothing at all.
    expect(error.message).not.toMatch(/ECONN|ETIMEDOUT|pg_hba\.conf entry|authentication failed|SELF_SIGNED/);
    expect(everythingSaid(h.events, [error.message, error.stack])).not.toContain(PASSWORD);
    // A failed login or check closes the admin client.
    for (const client of h.clients) expect(client.ended()).toBe(true);
  });

  it("refuses an RDS endpoint with a plain fix when the RDS roots are missing", async () => {
    const h = harness({ tls: new ProbeError("UNABLE_TO_GET_ISSUER_CERT_LOCALLY") });
    const error = await runDatabaseChecks(input(), { ...h.context, roots: { ...ROOTS, providers: { rds: false, azure: true } } }).then(() => new Error("did not fail"), (e: Error) => e);
    expect(error.message).toMatch(/missing Amazon RDS's signing roots/);
  });
});

describe("plain fixes", () => {
  const messages = [
    ...["localhost", "blocked-address", "private-literal", "private-not-allowed", "invalid-host", "invalid-port", "not-found", "dns-timeout"].map((reason) => dnsFix({ reason })),
    tcpFix(new ProbeError("ETIMEDOUT"), 5432), tcpFix(new ProbeError("ECONNREFUSED"), 5432), tcpFix(new ProbeError("EHOSTUNREACH"), 5432),
    ...["ENOTLS", "ETIMEDOUT", "EPROTOCOL", "ERR_TLS_CERT_ALTNAME_INVALID", "CERT_HAS_EXPIRED", "OTHER"].map((code) => tlsFix(new ProbeError(code), HOST, ROOTS)),
    tlsFix(new ProbeError("OTHER"), "db.example.com", ROOTS),
    ...["28P01", "28000", "3D000", "53300", "x"].map((code) => loginFix({ code })),
    CANNOT_CREATE_ROLES, versionFix(14), versionFix(null),
  ];

  it.each(messages)("passes clientErrorMessage unchanged: %s", (message) => {
    expect(isClientSafeError(new DatabaseSetupError(message, "check"))).toBe(true);
  });
});

describe("parseServerVersionNum", () => {
  it.each([["150000", 150000], ["170002", 170002], ["90624", 90624], ["16.4", null], [" 160000", null], [160000, null], ["1600000", null]])(
    "%j -> %j", (value, expected) => expect(parseServerVersionNum(value)).toBe(expected));
});
