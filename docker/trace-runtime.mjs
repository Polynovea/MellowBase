#!/usr/bin/env node
/**
 * Adds the delivery worker and the operator commands to the Next.js standalone output, so the server
 * image carries one pruned node_modules for everything.
 *
 *   node docker/trace-runtime.mjs <repo root> <standalone dir>
 *
 * It traces each entry point's imports with the same tracer `next build` uses for the standalone
 * output (@vercel/nft, bundled with Next.js) and copies every traced file that the standalone output
 * does not already have. Build-time only; it is not shipped.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const [rootArg, destArg] = process.argv.slice(2);
if (!rootArg || !destArg) {
  console.error("usage: trace-runtime.mjs <repo root> <standalone dir>");
  process.exit(2);
}
const root = path.resolve(rootArg);
const dest = path.resolve(destArg);

const ENTRY_POINTS = [
  "scripts/delivery-worker.mjs",
  "scripts/run-migrations.mjs",
  "scripts/polynovea-cms.mjs",
];

const require = createRequire(path.join(root, "package.json"));
const { nodeFileTrace } = require("next/dist/compiled/@vercel/nft");

const { fileList, warnings } = await nodeFileTrace(ENTRY_POINTS.map((file) => path.join(root, file)), {
  base: root,
  processCwd: root,
});

// The tracer does not read TypeScript (Node 24 runs .ts files directly by stripping types). Follow the
// relative imports of every traced .ts file by hand, trace any JavaScript they reach, and check that
// every package they import is already present.
const files = new Set([...fileList].map((file) => file.split(path.sep).join("/")));
const IMPORT = /(?:from\s+|import\s*\(\s*|import\s+)["']([^"']+)["']/g;
const barePackages = new Set();
const queue = [...files].filter((file) => file.endsWith(".ts"));
while (queue.length > 0) {
  const file = queue.pop();
  const text = readFileSync(path.join(root, file), "utf8");
  for (const [, specifier] of text.matchAll(IMPORT)) {
    if (specifier.startsWith("node:")) continue;
    if (!specifier.startsWith(".")) {
      barePackages.add(specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0]);
      continue;
    }
    const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier));
    if (files.has(resolved) || !existsSync(path.join(root, resolved))) continue;
    files.add(resolved);
    if (resolved.endsWith(".ts")) queue.push(resolved);
    else {
      const traced = await nodeFileTrace([path.join(root, resolved)], { base: root, processCwd: root });
      for (const extra of traced.fileList) {
        const normal = extra.split(path.sep).join("/");
        if (!files.has(normal)) {
          files.add(normal);
          if (normal.endsWith(".ts")) queue.push(normal);
        }
      }
    }
  }
}
const missing = [...barePackages].filter((name) => ![...files].some((file) => file.startsWith(`node_modules/${name}/`)) && !existsSync(path.join(dest, "node_modules", name)));
if (missing.length > 0) {
  console.error(`[trace-runtime] TypeScript files import packages the image would not have: ${missing.join(", ")}`);
  process.exit(1);
}

let copied = 0;
for (const relative of [...files].sort()) {
  if (relative.startsWith("..") || path.isAbsolute(relative)) continue;
  const source = path.join(root, relative);
  const target = path.join(dest, relative);
  if (existsSync(target) || !statSync(source).isFile()) continue;
  mkdirSync(path.dirname(target), { recursive: true });
  copyFileSync(source, target);
  copied += 1;
}

for (const warning of warnings ?? []) {
  const text = String(warning?.message ?? warning);
  // Guarded optional imports, licence files and TypeScript (handled above) are expected; anything else is worth reading.
  if (!/Cannot find module|Failed to resolve dependency|Failed to parse/.test(text)) console.warn(`[trace-runtime] ${text}`);
}
console.log(`[trace-runtime] ${files.size} files traced, ${copied} added to ${path.relative(root, dest) || dest}`);
