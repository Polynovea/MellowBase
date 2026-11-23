import { X509Certificate } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { rootCertificates } from "node:tls";

/**
 * The root certificates the database step trusts, and nothing else (no system store, no
 * DATABASE_CA_CERT): Amazon RDS's global bundle, DigiCert Global Root G2 and Microsoft RSA Root
 * Certificate Authority 2017 (Azure Database for PostgreSQL). Roots only, because both clouds rotate
 * intermediates without notice.
 *
 * The two Azure roots are taken from Node's bundled Mozilla store and pinned by SHA-256 fingerprint,
 * so a Node upgrade that dropped or changed one fails loudly instead of trusting something else. The
 * RDS bundle is AWS's own file (https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem),
 * shipped in ./ca/.
 *
 * config.enc records the bundle by ID (`caBundleId`), so the running app verifies the database with the
 * same roots the wizard used.
 */
export const MANAGED_DATABASE_CA_BUNDLE_ID = "polynovea-managed-db-1";

const PINNED_NODE_ROOTS: Readonly<Record<string, string>> = Object.freeze({
  "DigiCert Global Root G2": "CB:3C:CB:B7:60:31:E5:E0:13:8F:8D:D3:9A:23:F9:DE:47:FF:C3:5E:43:C1:14:4C:EA:27:D4:6A:5A:B1:CB:5F",
  "Microsoft RSA Root Certificate Authority 2017": "C7:41:F7:0F:4B:2A:8D:88:BF:2E:71:C1:41:22:EF:53:EF:10:EB:A0:CF:A5:E6:4C:FA:20:F4:18:85:30:73:E0",
});

export const RDS_BUNDLE_RELATIVE_PATH = path.join("lib", "setup", "database", "ca", "rds-global-bundle.pem");

export class CaBundleError extends Error {
  constructor(message: string, readonly missing: "rds" | "azure") {
    super(message);
    this.name = "CaBundleError";
  }
}

function splitPem(text: string): string[] {
  return text.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? [];
}

/** The pinned Azure roots from Node's store. Throws if either is missing or its fingerprint changed. */
export function azureRoots(store: readonly string[] = rootCertificates): string[] {
  const found = new Map<string, string>();
  for (const pem of store) {
    const certificate = new X509Certificate(pem);
    for (const [name, fingerprint] of Object.entries(PINNED_NODE_ROOTS)) {
      if (certificate.fingerprint256 === fingerprint) found.set(name, pem);
    }
  }
  const missing = Object.keys(PINNED_NODE_ROOTS).filter((name) => !found.has(name));
  if (missing.length) throw new CaBundleError(`Node's root store no longer has ${missing.join(" and ")}`, "azure");
  return [...found.values()];
}

/** AWS's RDS root bundle. Throws when the shipped file is missing or holds no valid certificate. */
export function rdsRoots(root: string = process.cwd()): string[] {
  const file = path.join(root, RDS_BUNDLE_RELATIVE_PATH);
  if (!existsSync(file)) throw new CaBundleError(`The Amazon RDS root bundle is missing (${RDS_BUNDLE_RELATIVE_PATH})`, "rds");
  const pems = splitPem(readFileSync(file, "utf8"));
  const now = Date.now();
  const valid = pems.filter((pem) => {
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

export interface TrustedRoots {
  id: typeof MANAGED_DATABASE_CA_BUNDLE_ID;
  ca: string[];
  /** Which providers' roots could be loaded; a missing RDS bundle leaves only Azure's. */
  providers: { rds: boolean; azure: boolean };
}

let cached: TrustedRoots | null = null;

/** The managed-database roots. Azure's are required; RDS's are included when the file is present. */
export function managedDatabaseRoots(options: { root?: string; store?: readonly string[]; fresh?: boolean } = {}): TrustedRoots {
  if (cached && !options.fresh && !options.root && !options.store) return cached;
  const azure = azureRoots(options.store);
  let rds: string[] = [];
  try {
    rds = rdsRoots(options.root);
  } catch (error) {
    if (!(error instanceof CaBundleError)) throw error;
  }
  const roots: TrustedRoots = { id: MANAGED_DATABASE_CA_BUNDLE_ID, ca: [...rds, ...azure], providers: { rds: rds.length > 0, azure: true } };
  if (!options.root && !options.store) cached = roots;
  return roots;
}

/** The roots for a `caBundleId` saved in config.enc; null for an ID this release does not know. */
export function certificateAuthoritiesFor(caBundleId: string | null): string[] | null {
  if (caBundleId === MANAGED_DATABASE_CA_BUNDLE_ID) return managedDatabaseRoots().ca;
  return null;
}
