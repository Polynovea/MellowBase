// Fails the build when the committed types file (polynovea-cms.ts) is out of date.
//
// With POLYNOVEA_CMS_URL set, it asks your CMS: `polynovea-cms types pull --check` (token from
// POLYNOVEA_CMS_TOKEN or POLYNOVEA_CMS_TOKEN_FILE). Without it (this repository's own build), the
// file must equal the SDK's fixture, which the CMS's emitter test regenerates from the fixture models.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const site = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const local = resolve(site, "polynovea-cms.ts");
const normalise = (text) => text.replace(/\r\n/g, "\n");

if (process.env.POLYNOVEA_CMS_URL) {
  const cli = resolve(site, "../../packages/cms-cli/bin/polynovea-cms.mjs");
  const args = [cli, "types", "pull", "--check", "--out", local];
  if (process.env.POLYNOVEA_CMS_TOKEN_FILE) args.push("--token-file", process.env.POLYNOVEA_CMS_TOKEN_FILE);
  const result = spawnSync(process.execPath, args, { stdio: "inherit", env: process.env });
  process.exit(result.status ?? 2);
}

const fixture = resolve(site, "../../packages/cms-sdk/test/fixture/polynovea-cms.ts");
if (normalise(readFileSync(local, "utf8")) !== normalise(readFileSync(fixture, "utf8"))) {
  console.error("types: polynovea-cms.ts differs from the SDK fixture. Copy packages/cms-sdk/test/fixture/polynovea-cms.ts here, or set POLYNOVEA_CMS_URL and run `npm run types:pull`.");
  process.exit(1);
}
console.log("types: polynovea-cms.ts matches the SDK fixture (no CMS configured, so the CMS was not asked).");
