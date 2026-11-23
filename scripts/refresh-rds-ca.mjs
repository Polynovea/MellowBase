// Downloads Amazon RDS's global root bundle and records it, for the setup wizard's database step.
//
// Usage: node scripts/refresh-rds-ca.mjs [--dry-run]
//
// Fetches only https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem, prints the old and new
// SHA-256 and each certificate's subject and expiry, then (unless --dry-run) writes:
//   lib/setup/database/ca/rds-global-bundle.pem
//   lib/setup/database/ca/README.md        (download date and SHA-256)
//   lib/setup/database/caBundles.mjs        (RDS_BUNDLE_SHA256)
// Commit all three together. caBundles.test.ts fails if they disagree.

import { createHash, X509Certificate } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const SOURCE = "https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem";
const root = process.cwd();
const bundleFile = path.join(root, "lib", "setup", "database", "ca", "rds-global-bundle.pem");
const readmeFile = path.join(root, "lib", "setup", "database", "ca", "README.md");
const codeFile = path.join(root, "lib", "setup", "database", "caBundles.mjs");
const dryRun = process.argv.includes("--dry-run");

// Must match bundleSha256 in caBundles.mjs: line endings normalised to LF before hashing.
const sha256 = (text) => createHash("sha256").update(String(text).replace(/\r\n/g, "\n"), "utf8").digest("hex");

const response = await fetch(SOURCE, { redirect: "error" });
if (!response.ok) throw new Error(`Download failed: HTTP ${response.status}`);
const text = await response.text();
if (text.length > 2_000_000) throw new Error("The download is far larger than an RDS bundle; refusing it");
const pems = text.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? [];
if (pems.length === 0) throw new Error("The download holds no certificates");

console.log(`Certificates in the new bundle: ${pems.length}`);
for (const pem of pems) {
  const certificate = new X509Certificate(pem);
  const subject = certificate.subject.replace(/\n/g, ", ");
  if (!certificate.ca) throw new Error(`Not a CA certificate: ${subject}`);
  console.log(`  ${subject}  (expires ${new Date(certificate.validTo).toISOString().slice(0, 10)})`);
}

const oldHash = existsSync(bundleFile) ? sha256(readFileSync(bundleFile, "utf8")) : "(none)";
const newHash = sha256(text);
console.log(`\nOld SHA-256: ${oldHash}\nNew SHA-256: ${newHash}`);
if (oldHash === newHash) {
  console.log("Unchanged; nothing to do.");
  process.exit(0);
}
if (dryRun) {
  console.log("Dry run: nothing written.");
  process.exit(0);
}

const today = new Date().toISOString().slice(0, 10);
writeFileSync(bundleFile, text);
const readme = readFileSync(readmeFile, "utf8")
  .replace(/^- Downloaded: .*$/m, `- Downloaded: ${today}`)
  .replace(/^- SHA-256: .*$/m, `- SHA-256: ${newHash}`);
writeFileSync(readmeFile, readme);
const code = readFileSync(codeFile, "utf8");
const updated = code.replace(/^export const RDS_BUNDLE_SHA256 = (?:null|"[0-9a-f]{64}");$/m, `export const RDS_BUNDLE_SHA256 = "${newHash}";`);
if (updated === code) throw new Error("Could not find RDS_BUNDLE_SHA256 in caBundles.mjs");
writeFileSync(codeFile, updated);
console.log("\nUpdated the bundle, ca/README.md and RDS_BUNDLE_SHA256. Run the unit tests, then commit all three.");
