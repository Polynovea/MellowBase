import { describe, expect, it } from "vitest";
import { rootCertificates } from "node:tls";
import { pinnedTlsOptions, postgresConnectionConfig } from "./postgresTls.mjs";

const PEM = "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----";

describe("postgresConnectionConfig", () => {
  it("skips TLS for a local database with no sslmode", () => {
    expect(postgresConnectionConfig("postgresql://u:p@localhost:5432/db", {}).ssl).toBe(false);
    expect(postgresConnectionConfig("postgresql://u:p@[::1]:5432/db", {}).ssl).toBe(false);
  });

  it("honours an explicit sslmode=disable and strips it from the URL", () => {
    const config = postgresConnectionConfig("postgresql://u:p@db:5432/app?sslmode=disable", {});
    expect(config.ssl).toBe(false);
    expect(config.connectionString).toBe("postgresql://u:p@db:5432/app");
  });

  it.each(["", "?sslmode=require", "?sslmode=prefer", "?sslmode=verify-ca", "?sslmode=verify-full"])(
    "always verifies certificates for a remote database (%s)",
    (query) => {
      const config = postgresConnectionConfig(`postgresql://u:p@db.example.com:5432/app${query}`, {});
      expect(config.ssl).toEqual({ rejectUnauthorized: true });
      expect(config.connectionString).not.toContain("sslmode");
    },
  );

  it("verifies a local database when TLS is requested", () => {
    expect(postgresConnectionConfig("postgresql://u:p@localhost/db?sslmode=require", {}).ssl).toEqual({ rejectUnauthorized: true });
  });

  it("adds DATABASE_CA_CERT on top of the system roots, with escaped newlines", () => {
    const config = postgresConnectionConfig("postgresql://u:p@db.example.com/app", { DATABASE_CA_CERT: PEM.replace(/\n/g, "\\n") });
    expect(config.ssl).toEqual({ rejectUnauthorized: true, ca: [...rootCertificates, PEM] });
  });

  it("drops file-reading SSL parameters from user-supplied URLs", () => {
    const config = postgresConnectionConfig("postgresql://u:p@db.example.com/app?sslrootcert=/etc/passwd&sslkey=/x&application_name=cms", {});
    expect(config.connectionString).toBe("postgresql://u:p@db.example.com/app?application_name=cms");
  });
});

describe("pinnedTlsOptions", () => {
  it("verifies against only the given roots and checks the real hostname", () => {
    expect(pinnedTlsOptions({ servername: "db.abc.eu-west-1.rds.amazonaws.com", ca: [PEM] }))
      .toEqual({ rejectUnauthorized: true, servername: "db.abc.eu-west-1.rds.amazonaws.com", ca: [PEM], minVersion: "TLSv1.2" });
  });

  it.each(["", "10.0.0.5", "[::1]", "2606:4700::1"])("refuses %j as the server name", (servername) => {
    expect(() => pinnedTlsOptions({ servername, ca: [PEM] })).toThrow(/hostname/);
  });

  it("refuses an empty or non-PEM root list (there is no unverified fallback)", () => {
    expect(() => pinnedTlsOptions({ servername: "db.example.com", ca: [] })).toThrow(/root/);
    expect(() => pinnedTlsOptions({ servername: "db.example.com", ca: ["not a cert"] })).toThrow(/root/);
  });
});
