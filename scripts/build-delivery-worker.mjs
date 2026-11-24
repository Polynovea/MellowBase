#!/usr/bin/env node
/**
 * Bundles the server image's workers, each to one plain-JavaScript file:
 *
 *   node scripts/build-delivery-worker.mjs   # dist/delivery-worker.mjs, dist/schema-migration-worker.mjs
 *
 * The schema migration worker (polynovea_owner, its own pool) is bundled the same way; it reads the
 * owner login from config.enc itself, so the credential never passes through the server's env.
 *
 * The worker imports TypeScript (the items API's permission check, lib/developer/items/schedule.ts,
 * with `@/` imports) that plain Node cannot load without the development loader. The image ships no
 * loader and no lib/**\/*.ts: it runs this bundle (docker/entrypoint.mjs), with npm packages left as
 * imports (docker/trace-runtime.mjs copies them). `npm run worker:delivery` keeps the loader for local
 * development. Rolldown is a pinned devDependency.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Bare npm specifiers (and node: builtins) stay imports; the repo's own files are inlined. */
export function isExternal(id) {
  if (id.startsWith("node:")) return true;
  if (id.startsWith(".") || id.startsWith("@/") || path.isAbsolute(id) || /^[A-Za-z]:[\\/]/.test(id)) return false;
  return true;
}

/**
 * Builds `input` (relative to the repo root) into `outFile` as ESM for Node. Returns the TypeScript
 * modules that were inlined (repo-relative), for the build log and tests.
 */
export async function buildWorker({ input = "scripts/delivery-worker.mjs", outFile = "dist/delivery-worker.mjs", root = ROOT } = {}) {
  const { build } = await import("rolldown");
  const result = await build({
    input: path.join(root, input),
    platform: "node",
    external: isExternal,
    resolve: { alias: { "@": root }, extensions: [".ts", ".tsx", ".mjs", ".js", ".json"] },
    output: { file: path.join(root, outFile), format: "esm", codeSplitting: false, banner: "// Built by scripts/build-delivery-worker.mjs. Do not edit." },
    write: true,
    logLevel: "warn",
  });
  const modules = Object.keys(result.output[0].modules ?? {})
    .map((file) => path.relative(root, file).split(path.sep).join("/"))
    .filter((file) => file.endsWith(".ts"))
    .sort();
  return { outFile: path.join(root, outFile), typeScriptModules: modules };
}

/** The workers the server image runs, each as one bundle. */
export const WORKERS = [
  { input: "scripts/delivery-worker.mjs", outFile: "dist/delivery-worker.mjs" },
  { input: "scripts/schema-migration-worker.mjs", outFile: "dist/schema-migration-worker.mjs" },
];

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  for (const worker of WORKERS) {
    const { outFile: written, typeScriptModules } = await buildWorker(worker);
    if (!existsSync(written)) throw new Error(`The worker bundle was not written: ${written}`);
    console.log(`[build-delivery-worker] ${path.relative(ROOT, written)} (${typeScriptModules.length} TypeScript modules inlined)`);
  }
}
