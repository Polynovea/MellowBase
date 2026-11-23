import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { LookupAddress } from "node:dns";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  BlockedDestinationError, createGuardedLookup, DatabaseTargetError, embeddedIPv4, guardedFetch, isAlwaysBlockedAddress, isBlockedAddress,
  isManagedDatabaseHostname, parseDatabaseAllowlist, resolveDatabaseTarget,
} from "./guardedNetwork";

const fakeDns = (addresses: string[]) => (_host: string, cb: (e: NodeJS.ErrnoException | null, a: LookupAddress[]) => void) =>
  cb(null, addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 })));

function runLookup(lookup: ReturnType<typeof createGuardedLookup>, all: boolean) {
  return new Promise<{ error: Error | null; address: unknown; family?: number }>((resolve) =>
    lookup("example.test", { all }, (error, address, family) => resolve({ error, address, family })));
}

describe("isBlockedAddress", () => {
  it.each(["127.0.0.1", "127.8.8.8", "10.0.0.1", "172.16.5.5", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1",
    "::1", "::", "fd12::1", "fe80::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1", "::127.0.0.1", "64:ff9b::a00:1", "[::1]", "not-an-ip",
    "168.63.129.16", "fd00:ec2::254", "::ffff:a9fe:a9fe", "::ffff:7f00:1", "::7f00:1", "::ffff:0:127.0.0.1", "2002:7f00:1::1", "::ffff:168.63.129.16"])(
    "blocks %s", (address) => expect(isBlockedAddress(address)).toBe(true));

  it.each(["93.184.216.34", "1.1.1.1", "2606:4700:4700::1111", "::ffff:8.8.8.8", "::ffff:808:808", "2002:808:808::1", "168.63.129.17"])(
    "allows %s", (address) => expect(isBlockedAddress(address)).toBe(false));
});

describe("createGuardedLookup", () => {
  it("returns only validated public addresses to the socket", async () => {
    const result = await runLookup(createGuardedLookup({ resolve: fakeDns(["93.184.216.34"]) }), false);
    expect(result).toEqual({ error: null, address: "93.184.216.34", family: 4 });
  });

  it("returns the full validated list when the socket asks for all", async () => {
    const result = await runLookup(createGuardedLookup({ resolve: fakeDns(["93.184.216.34", "2606:4700::1"]) }), true);
    expect(result.error).toBeNull();
    expect(result.address).toHaveLength(2);
  });

  it("refuses when any answer is private (the rebinding case)", async () => {
    const result = await runLookup(createGuardedLookup({ resolve: fakeDns(["93.184.216.34", "10.0.0.5"]) }), true);
    expect(result.error).toBeInstanceOf(BlockedDestinationError);
  });

  it("allows private answers only when explicitly permitted (local environments)", async () => {
    const result = await runLookup(createGuardedLookup({ allowPrivate: true, resolve: fakeDns(["127.0.0.1"]) }), false);
    expect(result.error).toBeNull();
  });
});

describe("guardedFetch against a real socket", () => {
  let server: Server;
  let port = 0;
  beforeAll(async () => {
    server = createServer((_req, res) => res.end("internal"));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it("blocks at connect time when a hostname resolves to loopback", async () => {
    // "localhost." skips the literal check, so only the connect-time lookup can stop it.
    const error = await guardedFetch(`http://localhost.:${port}/`).then(() => null, (e: Error & { cause?: unknown }) => e);
    expect(error?.cause).toBeInstanceOf(BlockedDestinationError);
  });

  it("connects through the guarded dispatcher when private destinations are allowed", async () => {
    const response = await guardedFetch(`http://127.0.0.1:${port}/`, {}, { allowPrivate: true });
    expect(await response.text()).toBe("internal");
  });
});

describe("guardedFetch", () => {
  it.each(["https://127.0.0.1/", "https://[::1]/", "https://169.254.169.254/latest", "https://localhost/", "http://[::ffff:127.0.0.1]/"])(
    "refuses the literal destination %s before connecting", async (url) => {
      await expect(guardedFetch(url)).rejects.toBeInstanceOf(BlockedDestinationError);
    });
});

describe("embeddedIPv4", () => {
  it.each([
    ["::ffff:127.0.0.1", "127.0.0.1"], ["::ffff:7f00:1", "127.0.0.1"], ["::127.0.0.1", "127.0.0.1"], ["::ffff:0:a9fe:a9fe", "169.254.169.254"],
    ["2002:a9fe:a9fe::", "169.254.169.254"], ["0:0:0:0:0:ffff:a00:1", "10.0.0.1"], ["2606:4700::1", null], ["fe80::1", null],
  ])("%s carries %s", (address, expected) => expect(embeddedIPv4(address)).toBe(expected));
});

describe("isAlwaysBlockedAddress", () => {
  it.each(["127.0.0.1", "169.254.169.254", "168.63.129.16", "0.1.2.3", "224.0.0.1", "255.255.255.255", "240.0.0.1", "192.0.2.10",
    "::1", "::", "fe80::1", "ff02::1", "fd00:ec2::254", "::ffff:169.254.169.254", "::ffff:a9fe:a9fe", "::ffff:168.63.129.16", "::ffff:a83f:8110",
    "64:ff9b::a9fe:a9fe", "2001:db8::1", "100.100.100.200"])(
    "always blocks %s", (address) => expect(isAlwaysBlockedAddress(address)).toBe(true));

  it.each(["10.1.2.3", "172.20.0.5", "192.168.0.10", "100.64.1.1", "fd12:3456::1", "::ffff:10.0.0.1", "8.8.8.8"])(
    "leaves %s to the private-address rule", (address) => expect(isAlwaysBlockedAddress(address)).toBe(false));
});

describe("isManagedDatabaseHostname", () => {
  it.each(["mydb.abc123.eu-west-1.rds.amazonaws.com", "MyDB.ABC.us-east-1.RDS.AmazonAWS.com.", "pg.postgres.database.azure.com", "a.b.postgres.database.azure.com"])(
    "accepts %s", (host) => expect(isManagedDatabaseHostname(host)).toBe(true));

  it.each(["rds.amazonaws.com", ".rds.amazonaws.com", "evilrds.amazonaws.com", "rds.amazonaws.com.evil.com", "x.rds.amazonaws.com.evil.com",
    "postgres.database.azure.com", "xpostgres.database.azure.com", "db.postgres.database.azure.com.attacker.net", "db.rds-amazonaws.com", "db.rds.amazonaws.co",
    "a..rds.amazonaws.com", "db_x.rds.amazonaws.com"])(
    "refuses %s", (host) => expect(isManagedDatabaseHostname(host)).toBe(false));
});

describe("parseDatabaseAllowlist", () => {
  it("reads hostnames, single addresses and networks separated by commas or spaces", () => {
    const list = parseDatabaseAllowlist(" db.corp.internal, 10.20.0.0/16  fd00:1::/64\n172.16.4.4 ");
    expect([...list.hostnames]).toEqual(["db.corp.internal"]);
    expect(list.networks.check("10.20.3.4", "ipv4")).toBe(true);
    expect(list.networks.check("10.21.0.1", "ipv4")).toBe(false);
    expect(list.networks.check("172.16.4.4", "ipv4")).toBe(true);
    expect(list.networks.check("fd00:1::5", "ipv6")).toBe(true);
    expect(parseDatabaseAllowlist(undefined).entries).toEqual([]);
  });

  it.each(["10.0.0.0/33", "not a host!", "db/16", "http://db.internal"])("fails closed on the bad entry %s", (entry) => {
    expect(() => parseDatabaseAllowlist(entry)).toThrow(/POLYNOVEA_SETUP_DB_ALLOWLIST/);
  });
});

describe("resolveDatabaseTarget", () => {
  const dns = (map: Record<string, string[]>) => {
    const calls: string[] = [];
    const resolve = (host: string, cb: (e: NodeJS.ErrnoException | null, a: LookupAddress[]) => void) => {
      calls.push(host);
      const answers = map[host];
      if (!answers) return cb(Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: "ENOTFOUND" }), []);
      cb(null, answers.map((address) => ({ address, family: address.includes(":") ? 6 : 4 })));
    };
    return { resolve, calls };
  };
  const reason = (promise: Promise<unknown>) =>
    promise.then(() => "resolved", (error: unknown) => (error instanceof DatabaseTargetError ? error.reason : `other: ${String(error)}`));

  describe("acceptance test 5: the address field refuses", () => {
    it.each([
      ["169.254.169.254", "blocked-address"],
      ["127.0.0.1", "blocked-address"],
      ["localhost", "localhost"],
      ["LocalHost.", "localhost"],
      ["db.localhost", "localhost"],
      ["::ffff:127.0.0.1", "blocked-address"],
      ["[::ffff:169.254.169.254]", "blocked-address"],
      ["::ffff:7f00:1", "blocked-address"],
      ["::ffff:10.0.0.5", "ip-literal"],
      ["168.63.129.16", "blocked-address"],
      ["fd00:ec2::254", "blocked-address"],
      ["10.0.0.5", "ip-literal"],
    ])("%s", async (host, expected) => {
      const { resolve, calls } = dns({});
      expect(await reason(resolveDatabaseTarget(host, 5432, { resolve }))).toBe(expected);
      expect(calls).toEqual([]); // literals and localhost never reach DNS
    });

    it("a DNS name that resolves to a private IP", async () => {
      const { resolve } = dns({ "db.example.com": ["10.0.3.7"] });
      expect(await reason(resolveDatabaseTarget("db.example.com", 5432, { resolve }))).toBe("private-not-allowed");
    });

    it("a DNS name that resolves to the metadata address, even for a managed-database name or an allowlisted host", async () => {
      const { resolve } = dns({ "x.abc.us-east-1.rds.amazonaws.com": ["169.254.169.254"], "db.corp.internal": ["::ffff:169.254.169.254"] });
      expect(await reason(resolveDatabaseTarget("x.abc.us-east-1.rds.amazonaws.com", 5432, { resolve }))).toBe("blocked-address");
      expect(await reason(resolveDatabaseTarget("db.corp.internal", 5432, { resolve, allowlist: "db.corp.internal, 0.0.0.0/0, ::/0" }))).toBe("blocked-address");
    });
  });

  it("refuses the whole target when any answer is blocked (the rebinding case) and resolves exactly once", async () => {
    const { resolve, calls } = dns({ "x.abc.eu-west-1.rds.amazonaws.com": ["10.0.0.8", "127.0.0.1"], "public.example.com": ["93.184.216.34", "10.0.0.8"] });
    expect(await reason(resolveDatabaseTarget("x.abc.eu-west-1.rds.amazonaws.com", 5432, { resolve }))).toBe("blocked-address");
    expect(await reason(resolveDatabaseTarget("public.example.com", 5432, { resolve }))).toBe("private-not-allowed");
    expect(calls).toEqual(["x.abc.eu-west-1.rds.amazonaws.com", "public.example.com"]);
  });

  it("pins the checked address: a later, different DNS answer is never used", async () => {
    let answer = "93.184.216.34";
    const resolve = (_host: string, cb: (e: NodeJS.ErrnoException | null, a: LookupAddress[]) => void) => cb(null, [{ address: answer, family: 4 }]);
    const target = await resolveDatabaseTarget("db.example.com", 5432, { resolve });
    answer = "127.0.0.1";
    expect(target).toMatchObject({ hostname: "db.example.com", address: "93.184.216.34", port: 5432, allowedBy: "public" });
  });

  it("allows private answers for RDS and Azure endpoint names, case-insensitively and with a trailing dot", async () => {
    const { resolve } = dns({ "mydb.abc.eu-west-1.rds.amazonaws.com": ["10.0.1.20"], "pg1.postgres.database.azure.com": ["fd12::7"] });
    await expect(resolveDatabaseTarget("MyDB.abc.EU-WEST-1.rds.amazonaws.com.", 5432, { resolve }))
      .resolves.toMatchObject({ address: "10.0.1.20", allowedBy: "managed-database", hostname: "mydb.abc.eu-west-1.rds.amazonaws.com" });
    await expect(resolveDatabaseTarget("pg1.postgres.database.azure.com", 6432, { resolve })).resolves.toMatchObject({ address: "fd12::7", family: 6, port: 6432 });
  });

  it.each(["rds.amazonaws.com.evil.com", "evilrds.amazonaws.com", "x.postgres.database.azure.com.evil.net"])("suffix trick %s gets no private access", async (host) => {
    const { resolve } = dns({ [host]: ["10.0.0.9"] });
    expect(await reason(resolveDatabaseTarget(host, 5432, { resolve }))).toBe("private-not-allowed");
  });

  it("allows private answers for an operator-allowlisted hostname or network only", async () => {
    const { resolve } = dns({ "db.corp.internal": ["10.9.0.4"], "other.corp.internal": ["10.9.0.5"], "far.corp.internal": ["10.10.0.5"] });
    const allowlist = "db.corp.internal 10.9.0.0/16";
    await expect(resolveDatabaseTarget("DB.corp.internal", 5432, { resolve, allowlist })).resolves.toMatchObject({ allowedBy: "allowlist" });
    await expect(resolveDatabaseTarget("other.corp.internal", 5432, { resolve, allowlist })).resolves.toMatchObject({ allowedBy: "allowlist", address: "10.9.0.5" });
    expect(await reason(resolveDatabaseTarget("far.corp.internal", 5432, { resolve, allowlist }))).toBe("private-not-allowed");
    expect(await reason(resolveDatabaseTarget("far.corp.internal", 5432, { resolve }))).toBe("private-not-allowed");
  });

  it("refuses every IP literal, public ones too, without DNS (TLS needs the name)", async () => {
    const { resolve, calls } = dns({});
    for (const host of ["93.184.216.34", "[2606:4700::1111]", "2606:4700::1111", "8.8.8.8"]) {
      expect(await reason(resolveDatabaseTarget(host, 5432, { resolve }))).toBe("ip-literal");
    }
    expect(calls).toEqual([]);
  });

  it("still accepts a name that resolves to a public address", async () => {
    const { resolve } = dns({ "db.example.com": ["93.184.216.34"] });
    await expect(resolveDatabaseTarget("db.example.com", 5432, { resolve })).resolves.toMatchObject({ address: "93.184.216.34", allowedBy: "public" });
  });

  it.each([0, 65536, 5432.5, Number.NaN, "5432"])("refuses the port %s", async (port) => {
    expect(await reason(resolveDatabaseTarget("db.example.com", port as number))).toBe("invalid-port");
  });

  it.each(["", "user@db.example.com", "db.example.com:5432", "db.example.com/x", "-db.example.com", "db..example.com", "postgres://db.example.com", "fe80::1%eth0", "2606:4700::1%25eth0"])(
    "refuses the malformed host %j", async (host) => {
      expect(await reason(resolveDatabaseTarget(host, 5432, { resolve: dns({}).resolve }))).toBe("invalid-host");
    });

  it("reports a name that does not resolve as not found, without the resolver's message", async () => {
    const error = await resolveDatabaseTarget("missing.example.com", 5432, { resolve: dns({}).resolve }).catch((e: Error) => e);
    expect(error).toBeInstanceOf(DatabaseTargetError);
    expect((error as DatabaseTargetError).reason).toBe("not-found");
    expect((error as Error).message).not.toMatch(/ENOTFOUND|getaddrinfo/);
  });
});
