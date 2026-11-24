// The reference executor trusts the plan it is given, so it must stay test-only: the migration runner
// (which rebuilds every plan from trusted state) is the only production executor. This test fails if
// any non-test file imports it, or if the public engine index exports it again.
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import * as engine from "@/lib/schema/engine/index";

const ROOT = process.cwd();
const SCAN = ["app", "components", "lib", "packages", "scripts", "e2e", "middleware.ts", "instrumentation.ts"];
const SKIP_DIRS = new Set(["node_modules", ".next", "dist", "generated"]);
const SOURCE = /\.(ts|tsx|mts|js|mjs|cjs)$/;
const TEST_ONLY = /(\.test\.(ts|tsx)|\.testing\.ts)$/;
const REFERENCE = /referenceExecutor\.testing|\bapplyExpandStage\b|\bapplyDestructiveStage\b/;

function sources(entry: string): string[] {
  const full = path.join(ROOT, entry);
  let stats;
  try { stats = statSync(full); } catch { return []; }
  if (stats.isFile()) return SOURCE.test(entry) ? [entry] : [];
  return readdirSync(full).flatMap((name) => (SKIP_DIRS.has(name) ? [] : sources(path.join(entry, name))));
}

describe("schema engine boundary", () => {
  it("only tests use the reference executor", () => {
    const offenders = SCAN.flatMap(sources)
      .filter((file) => !TEST_ONLY.test(file))
      .filter((file) => REFERENCE.test(readFileSync(path.join(ROOT, file), "utf8")));
    expect(offenders).toEqual([]);
  });

  it("the public engine index does not export it", () => {
    expect(Object.keys(engine).filter((name) => /^apply(Expand|Destructive)Stage$/.test(name))).toEqual([]);
  });
});
