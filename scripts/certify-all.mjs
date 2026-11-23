#!/usr/bin/env node
/**
 * Runs every certification script (scripts/certify-*.mjs) one after another against a running CMS,
 * and prints a pass/fail summary. Exit code 1 when any script fails.
 *
 *   CMS_CERT_BASE_URL=http://localhost:3000 DATABASE_URL=<database owner URL> node scripts/certify-all.mjs [filter]
 *
 * The CMS under test needs no Supabase services. Start it with:
 *   AUTH_PROVIDER=builtin, NEXT_PUBLIC_AUTH_PROVIDER=builtin, POLYNOVEA_AUTH_SECRET (32+ characters),
 *   POLYNOVEA_PUBLIC_URL = CMS_CERT_BASE_URL, POLYNOVEA_DATABASE_URL (the app role),
 *   CMS_CONFIG_ENCRYPTION_KEY, POLYNOVEA_TRUSTED_PROXIES=127.0.0.1 (production builds),
 *   POLYNOVEA_HIBP_DISABLED=true, and the test credentials the connection scripts verify with:
 *   POLYNOVEA_CERT_CONNECTION_TOKEN and POLYNOVEA_CERT_CONNECTION_TOKEN_NEXT (any values).
 * Build the SDK first (npm run sdk:build): phase 12.5 imports it.
 *
 * An optional argument runs only the scripts whose file name contains it (e.g. "phase12").
 */
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";

// These two import TypeScript through the project's loader.
const NEEDS_LOADER = new Set(["certify-phase12_75.mjs", "certify-phase13-foundation.mjs", "certify-phase13-extensions.mjs"]);
const filter = process.argv[2] ?? "";
const scripts = readdirSync("scripts").filter((name) => /^certify-.*\.mjs$/.test(name) && name !== "certify-all.mjs" && name.includes(filter)).sort();

const results = [];
for (const name of scripts) {
  const args = NEEDS_LOADER.has(name)
    ? ["--experimental-strip-types", "--loader", "./scripts/phase12_75-node-loader.mjs", `scripts/${name}`]
    : [`scripts/${name}`];
  console.log(`\n### ${name}`);
  const started = Date.now();
  const { status } = spawnSync(process.execPath, args, { stdio: "inherit", env: process.env });
  results.push({ name, ok: status === 0, seconds: Math.round((Date.now() - started) / 1000) });
}

console.log("\n=== Certification summary ===");
for (const result of results) console.log(`${result.ok ? "PASS" : "FAIL"}  ${result.name} (${result.seconds}s)`);
const failed = results.filter((result) => !result.ok).length;
console.log(`${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
