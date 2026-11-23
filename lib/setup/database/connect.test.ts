import { describe, expect, it } from "vitest";
import type pg from "pg";
import { clientConfig, localEndpoint, openClient, remoteEndpoint, type DatabaseEndpoint } from "./connect";
import { fakeClient } from "./testFakes";

const PEM = "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----";
const TARGET = { hostname: "pg1.postgres.database.azure.com", address: "10.1.2.3", family: 4 as const, port: 5432, addresses: ["10.1.2.3"], allowedBy: "managed-database" as const };
const LOGIN = { user: "admin", password: "Adm1n-S3cret-Pa55word!" };

describe("clientConfig", () => {
  it("builds a remote config from discrete fields: pinned IP, real hostname for TLS, only the shipped roots", () => {
    const endpoint = remoteEndpoint(TARGET, { id: "bundle", ca: [PEM] });
    const config = clientConfig(endpoint, "postgres", LOGIN, { connectTimeoutMs: 5_000, statementTimeoutMs: 30_000 });
    expect(config).toEqual({
      host: "10.1.2.3", port: 5432, database: "postgres", user: "admin", password: LOGIN.password, application_name: "polynovea-setup",
      connectionTimeoutMillis: 5_000, statement_timeout: 30_000,
      ssl: { rejectUnauthorized: true, servername: "pg1.postgres.database.azure.com", ca: [PEM], minVersion: "TLSv1.2" },
    });
    expect(config).not.toHaveProperty("connectionString");
  });

  it("connects to the bundled server without TLS on 127.0.0.1 or a socket only", () => {
    expect(clientConfig(localEndpoint("127.0.0.1", 5432), "polynovea", LOGIN).ssl).toBe(false);
    expect(clientConfig(localEndpoint("/var/run/postgresql", 5432), "polynovea", LOGIN).host).toBe("/var/run/postgresql");
    for (const host of ["0.0.0.0", "10.0.0.1", "db.example.com", "localhost", "/tmp;rm"]) expect(() => localEndpoint(host, 5432)).toThrow(/127\.0\.0\.1 or a unix socket/);
  });

  it("refuses a remote endpoint without a pinned IP or without roots (no unverified fallback)", () => {
    expect(() => remoteEndpoint({ ...TARGET, address: "pg1.postgres.database.azure.com" }, { id: "bundle", ca: [PEM] })).toThrow(/pinned IP/);
    expect(() => remoteEndpoint(TARGET, { id: "bundle", ca: [] })).toThrow(/root certificates/);
    const forged = { kind: "remote", hostname: "10.1.2.3", address: "10.1.2.3", port: 5432, ca: [PEM], caBundleId: "x" } as DatabaseEndpoint;
    expect(() => clientConfig(forged, "postgres", LOGIN)).toThrow(/hostname/);
  });
});

describe("openClient", () => {
  it("drops the password from the client once connected", async () => {
    let made: pg.Client | null = null;
    const client = await openClient(localEndpoint("127.0.0.1", 5432), "polynovea", LOGIN, { factory: (config) => (made = fakeClient([], config).client) });
    expect(client).toBe(made);
    expect((client as unknown as { password: unknown }).password).toBeNull();
    expect((client as unknown as { connectionParameters: { password: unknown } }).connectionParameters.password).toBeNull();
  });

  it("drops the password and closes the client when connecting fails", async () => {
    const fake = fakeClient([], { password: LOGIN.password });
    (fake.client as unknown as { connect: () => Promise<void> }).connect = async () => { throw new Error("refused"); };
    await expect(openClient(localEndpoint("127.0.0.1", 5432), "polynovea", LOGIN, { factory: () => fake.client })).rejects.toThrow("refused");
    expect((fake.client as unknown as { password: unknown }).password).toBeNull();
    expect(fake.ended()).toBe(true);
  });
});
