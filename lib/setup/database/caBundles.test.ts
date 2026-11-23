import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";

import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { rootCertificates } from "node:tls";
import {
  bundleSha256, CaBundleError, certificateAuthoritiesFor, isRdsHostname, publicRoots, PUBLIC_CA_BUNDLE_ID, RDS_BUNDLE_RELATIVE_PATH, RDS_BUNDLE_SHA256, RDS_CA_BUNDLE_ID,
  rdsRoots, rootsForHost,
} from "./caBundles";

function bundleDir(contents: string) {
  const dir = mkdtempSync(path.join(tmpdir(), "rds-ca-"));
  mkdirSync(path.dirname(path.join(dir, RDS_BUNDLE_RELATIVE_PATH)), { recursive: true });
  writeFileSync(path.join(dir, RDS_BUNDLE_RELATIVE_PATH), contents);
  return { dir, sha256: bundleSha256(contents) };
}

describe("the shipped RDS bundle", () => {
  // Any change to the file must come with a matching RDS_BUNDLE_SHA256 (scripts/refresh-rds-ca.mjs
  // updates both and the README), so a silent edit or a corrupted copy fails here.
  const file = path.join(process.cwd(), RDS_BUNDLE_RELATIVE_PATH);

  it("matches RDS_BUNDLE_SHA256, or is absent while no hash is recorded", () => {
    if (RDS_BUNDLE_SHA256 === null) {
      expect(existsSync(file)).toBe(false);
      return;
    }
    expect(bundleSha256(readFileSync(file, "utf8"))).toBe(RDS_BUNDLE_SHA256);
    expect(rdsRoots().length).toBeGreaterThan(0);
  });

  it("still matches after a Windows checkout turns its line endings into CRLF", () => {
    if (RDS_BUNDLE_SHA256 === null) return;
    const crlf = readFileSync(file, "utf8").replace(/\r?\n/g, "\r\n");
    expect(bundleSha256(crlf)).toBe(RDS_BUNDLE_SHA256);
    const { dir } = bundleDir(crlf);
    expect(rdsRoots({ root: dir }).length).toBeGreaterThan(100);
  });

  it("keeps RDS_BUNDLE_SHA256 in the one-line form scripts/refresh-rds-ca.mjs rewrites", () => {
    const code = readFileSync(path.join(process.cwd(), "lib", "setup", "database", "caBundles.mjs"), "utf8");
    expect(code).toMatch(new RegExp(`^export const RDS_BUNDLE_SHA256 = ${RDS_BUNDLE_SHA256 === null ? "null" : `"${RDS_BUNDLE_SHA256}"`};$`, "m"));
  });

  it("loads in plain Node, without the app's path aliases (for scripts)", () => {
    const script = "import('./lib/setup/database/caBundles.mjs').then((m) => console.log(m.certificateAuthoritiesFor(m.RDS_CA_BUNDLE_ID).length, m.certificateAuthoritiesFor(m.PUBLIC_CA_BUNDLE_ID).length))";
    const output = execFileSync(process.execPath, ["--input-type=module", "-e", script], { cwd: process.cwd(), encoding: "utf8" }).trim();
    expect(output).toMatch(/^\d+ 2$/);
  });

  it("is recorded with the same hash in ca/README.md", () => {
    const readme = readFileSync(path.join(process.cwd(), "lib", "setup", "database", "ca", "README.md"), "utf8");
    expect(readme).toContain(RDS_BUNDLE_SHA256 === null ? "SHA-256: (not yet added)" : `SHA-256: ${RDS_BUNDLE_SHA256}`);
  });
});

describe("publicRoots", () => {
  it("finds DigiCert Global Root G2 and Microsoft RSA Root CA 2017 in Node's store by fingerprint", () => {
    expect(publicRoots()).toHaveLength(2);
  });

  it("fails loudly when the store no longer has them", () => {
    expect(() => publicRoots(rootCertificates.slice(0, 3))).toThrow(CaBundleError);
  });
});

describe("rdsRoots", () => {
  it("fails when the bundle is missing or no hash is recorded", () => {
    const empty = mkdtempSync(path.join(tmpdir(), "rds-ca-"));
    expect(() => rdsRoots({ root: empty, expectedSha256: "0".repeat(64) })).toThrow(/missing/);
    const { dir } = bundleDir(publicRoots().join("\n"));
    expect(() => rdsRoots({ root: dir, expectedSha256: null })).toThrow(/missing/);
  });

  it("refuses a file that does not match the recorded SHA-256", () => {
    const { dir } = bundleDir(publicRoots().join("\n"));
    expect(() => rdsRoots({ root: dir, expectedSha256: "0".repeat(64) })).toThrow(/does not match/);
  });

  it("refuses a matching file with no valid certificate", () => {
    const { dir, sha256 } = bundleDir("-----BEGIN CERTIFICATE-----\nnot base64\n-----END CERTIFICATE-----\n");
    expect(() => rdsRoots({ root: dir, expectedSha256: sha256 })).toThrow(/no valid certificate/);
  });

  it("reads the CA certificates from a matching bundle", () => {
    // Two real roots stand in for the RDS bundle's format (concatenated PEM).
    const { dir, sha256 } = bundleDir(publicRoots().join("\n"));
    expect(rdsRoots({ root: dir, expectedSha256: sha256 })).toHaveLength(2);
  });
});

describe("rootsForHost", () => {
  it.each(["mydb.abc.eu-west-1.rds.amazonaws.com", "MyDB.ABC.us-east-1.RDS.amazonaws.com."])("uses only the RDS bundle for %s", (host) => {
    expect(isRdsHostname(host)).toBe(true);
    if (RDS_BUNDLE_SHA256 === null) {
      expect(() => rootsForHost(host)).toThrow(expect.objectContaining({ missing: "rds" }));
    } else {
      expect(rootsForHost(host).id).toBe(RDS_CA_BUNDLE_ID);
    }
  });

  it.each(["pg1.postgres.database.azure.com", "db.corp.internal", "rds.amazonaws.com.evil.com", "evilrds.amazonaws.com", "x.rds.amazonaws.com.evil.com"])(
    "never gives the RDS bundle to %s", (host) => {
      expect(isRdsHostname(host)).toBe(false);
      const roots = rootsForHost(host);
      expect(roots.id).toBe(PUBLIC_CA_BUNDLE_ID);
      expect(roots.ca).toEqual(publicRoots());
    });

  it("maps a saved caBundleId back to its roots, and an unknown one to null", () => {
    expect(certificateAuthoritiesFor(PUBLIC_CA_BUNDLE_ID)).toHaveLength(2);
    expect(certificateAuthoritiesFor("something-else")).toBeNull();
    expect(certificateAuthoritiesFor(null)).toBeNull();
  });
});
