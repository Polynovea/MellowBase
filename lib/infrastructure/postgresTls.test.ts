import { describe, expect, it } from "vitest";
import { rootCertificates } from "node:tls";
import { postgresConnectionConfig } from "./postgresTls.mjs";

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
