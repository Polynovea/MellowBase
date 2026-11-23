import { createHash, X509Certificate } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { rootCertificates } from "node:tls";
import { isManagedDatabaseHostname, normalizeDatabaseHostname } from "@/lib/infrastructure/guardedNetwork.mjs";

/**
 * The root certificates the database step trusts. Never the system store, never DATABASE_CA_CERT, and
 * each host gets only its own provider's roots:
 *
 * - Amazon RDS endpoints (`*.rds.amazonaws.com`, label boundary as in the host check): AWS's RDS global
 *   bundle only, shipped in ./ca/ and checked against RDS_BUNDLE_SHA256 before use. It is never used
 *   for any other host.
 * - Every other endpoint (Azure Database for PostgreSQL, or a host the operator allowed): DigiCert Global
 *   Root G2 and Microsoft RSA Root Certificate Authority 2017, taken from Node's bundled Mozilla store
 *   and pinned by SHA-256 fingerprint, so a Node upgrade that dropped or changed one fails loudly.
 *
 * These are trust anchors (roots) only, never pinned leaf or intermediate certificates: both clouds
 * rotate intermediates without notice. config.enc records the set by ID (`caBundleId`), so the running
 * app verifies the database with the same roots the wizard used (certificateAuthoritiesFor).
 */
export const RDS_CA_BUNDLE_ID = "aws-rds-global-1";
export const PUBLIC_CA_BUNDLE_ID = "digicert-microsoft-1";

/**
 * SHA-256 of ca/rds-global-bundle.pem. Null until the bundle is added. Changing it is a deliberate,
 * reviewed step: scripts/refresh-rds-ca.mjs downloads the bundle and updates this value, the README and
 * the test together.
 */
export const RDS_BUNDLE_SHA256: string | null = "90a6f1a7978a1b1b096dca6c57511ca48d3b8cf052f8e704baf358f34ea2f21b";

export const RDS_BUNDLE_RELATIVE_PATH = path.join("lib", "setup", "database", "ca", "rds-global-bundle.pem");

const PINNED_NODE_ROOTS: Readonly<Record<string, string>> = Object.freeze({
  "DigiCert Global Root G2": "CB:3C:CB:B7:60:31:E5:E0:13:8F:8D:D3:9A:23:F9:DE:47:FF:C3:5E:43:C1:14:4C:EA:27:D4:6A:5A:B1:CB:5F",
  "Microsoft RSA Root Certificate Authority 2017": "C7:41:F7:0F:4B:2A:8D:88:BF:2E:71:C1:41:22:EF:53:EF:10:EB:A0:CF:A5:E6:4C:FA:20:F4:18:85:30:73:E0",
});

export class CaBundleError extends Error {
  constructor(message: string, readonly missing: "rds" | "public") {
    super(message);
    this.name = "CaBundleError";
  }
}

export interface TrustedRoots {
  id: typeof RDS_CA_BUNDLE_ID | typeof PUBLIC_CA_BUNDLE_ID;
  ca: string[];
}

/** True for an Amazon RDS endpoint name: `<label>….rds.amazonaws.com`, case-insensitive, trailing dot allowed. */
export function isRdsHostname(hostname: string): boolean {
  return isManagedDatabaseHostname(hostname) && normalizeDatabaseHostname(hostname).endsWith(".rds.amazonaws.com");
}

/**
 * SHA-256 of the bundle text with line endings normalised to LF (as AWS serves it), so a Windows
 * checkout that turns them into CRLF still matches the recorded value.
 */
export function bundleSha256(text: string): string {
  return createHash("sha256").update(text.replace(/\r\n/g, "\n"), "utf8").digest("hex");
}

function splitPem(text: string): string[] {
  return text.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? [];
}

/** DigiCert Global Root G2 and Microsoft RSA Root CA 2017 from Node's store. Throws if either is missing or changed. */
export function publicRoots(store: readonly string[] = rootCertificates): string[] {
  const found = new Map<string, string>();
  for (const pem of store) {
    const certificate = new X509Certificate(pem);
    for (const [name, fingerprint] of Object.entries(PINNED_NODE_ROOTS)) {
      if (certificate.fingerprint256 === fingerprint) found.set(name, pem);
    }
  }
  const missing = Object.keys(PINNED_NODE_ROOTS).filter((name) => !found.has(name));
  if (missing.length) throw new CaBundleError(`Node's root store no longer has ${missing.join(" and ")}`, "public");
  return [...found.values()];
}

/**
 * AWS's RDS root bundle. Throws when the shipped file is missing, does not match RDS_BUNDLE_SHA256, or
 * holds no valid CA certificate.
 */
export function rdsRoots(options: { root?: string; expectedSha256?: string | null } = {}): string[] {
  const file = path.join(options.root ?? process.cwd(), RDS_BUNDLE_RELATIVE_PATH);
  const expected = options.expectedSha256 === undefined ? RDS_BUNDLE_SHA256 : options.expectedSha256;
  if (!expected || !existsSync(file)) throw new CaBundleError(`The Amazon RDS root bundle is missing (${RDS_BUNDLE_RELATIVE_PATH})`, "rds");
  const bytes = readFileSync(file);
  if (bundleSha256(bytes.toString("utf8")) !== expected) {
    throw new CaBundleError("The Amazon RDS root bundle does not match its recorded SHA-256", "rds");
  }
  const now = Date.now();
  const valid = splitPem(bytes.toString("utf8")).filter((pem) => {
    try {
      const certificate = new X509Certificate(pem);
      return certificate.ca && Date.parse(certificate.validTo) > now;
    } catch {
      return false;
    }
  });
  if (valid.length === 0) throw new CaBundleError("The Amazon RDS root bundle holds no valid certificate", "rds");
  return valid;
}

/** The roots for one endpoint name. Throws CaBundleError when they cannot be loaded (no fallback). */
export function rootsForHost(hostname: string): TrustedRoots {
  return isRdsHostname(hostname) ? { id: RDS_CA_BUNDLE_ID, ca: rdsRoots() } : { id: PUBLIC_CA_BUNDLE_ID, ca: publicRoots() };
}

/** The roots for a `caBundleId` saved in config.enc; null for an ID this release does not know. */
export function certificateAuthoritiesFor(caBundleId: string | null): string[] | null {
  if (caBundleId === RDS_CA_BUNDLE_ID) return rdsRoots();
  if (caBundleId === PUBLIC_CA_BUNDLE_ID) return publicRoots();
  return null;
}
