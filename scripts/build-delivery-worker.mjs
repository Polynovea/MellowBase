#!/usr/bin/env node
/**
 * Bundles the delivery worker to one plain-JavaScript file for the server image:
 *
 *   node scripts/build-delivery-worker.mjs [--out=dist/delivery-worker.mjs]
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

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const outArg = process.argv.find((arg) => arg.startsWith("--out="));
  const outFile = outArg ? outArg.slice("--out=".length) : "dist/delivery-worker.mjs";
  const { outFile: written, typeScriptModules } = await buildWorker({ outFile });
  if (!existsSync(written)) throw new Error(`The worker bundle was not written: ${written}`);
  console.log(`[build-delivery-worker] ${path.relative(ROOT, written)} (${typeScriptModules.length} TypeScript modules inlined)`);
}
