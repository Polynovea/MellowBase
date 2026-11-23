import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { rootCertificates } from "node:tls";
import { azureRoots, CaBundleError, certificateAuthoritiesFor, managedDatabaseRoots, MANAGED_DATABASE_CA_BUNDLE_ID, rdsRoots, RDS_BUNDLE_RELATIVE_PATH } from "./caBundles";

describe("azureRoots", () => {
  it("finds DigiCert Global Root G2 and Microsoft RSA Root CA 2017 in Node's store by fingerprint", () => {
    expect(azureRoots()).toHaveLength(2);
  });

  it("fails loudly when the store no longer has them", () => {
    expect(() => azureRoots(rootCertificates.slice(0, 3))).toThrow(CaBundleError);
  });
});

describe("rdsRoots", () => {
  it("fails when the shipped bundle is missing or holds nothing valid", () => {
    const empty = mkdtempSync(path.join(tmpdir(), "rds-ca-"));
    expect(() => rdsRoots(empty)).toThrow(/missing/);
    mkdirSync(path.dirname(path.join(empty, RDS_BUNDLE_RELATIVE_PATH)), { recursive: true });
    writeFileSync(path.join(empty, RDS_BUNDLE_RELATIVE_PATH), "-----BEGIN CERTIFICATE-----\nnot base64\n-----END CERTIFICATE-----\n");
    expect(() => rdsRoots(empty)).toThrow(/no valid certificate/);
  });

  it("reads valid CA certificates from the bundle", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "rds-ca-"));
    mkdirSync(path.dirname(path.join(dir, RDS_BUNDLE_RELATIVE_PATH)), { recursive: true });
    // Two real roots stand in for the RDS bundle's format (concatenated PEM).
    writeFileSync(path.join(dir, RDS_BUNDLE_RELATIVE_PATH), azureRoots().join("\n"));
    expect(rdsRoots(dir)).toHaveLength(2);
  });
});

describe("managedDatabaseRoots", () => {
  it("never includes the system store, and says which providers it covers", () => {
    const empty = mkdtempSync(path.join(tmpdir(), "rds-ca-"));
    const roots = managedDatabaseRoots({ root: empty });
    expect(roots).toMatchObject({ id: MANAGED_DATABASE_CA_BUNDLE_ID, providers: { rds: false, azure: true } });
    expect(roots.ca).toHaveLength(2);
    expect(roots.ca.length).toBeLessThan(rootCertificates.length);
  });

  it("maps a saved caBundleId back to the same roots, and an unknown one to null", () => {
    expect(certificateAuthoritiesFor(MANAGED_DATABASE_CA_BUNDLE_ID)?.length).toBeGreaterThanOrEqual(2);
    expect(certificateAuthoritiesFor("something-else")).toBeNull();
    expect(certificateAuthoritiesFor(null)).toBeNull();
  });
});
