import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createOwnerPool, ownerPoolConfig } from "@/lib/schema/runner/ownerPool";

// Guard: the request that asks for a schema change never holds owner rights. Only the runner itself
// and the worker process may import the modules that open the owner pool or apply a stage; the CMS
// server imports lib/schema/runner (index.ts), which only writes and reads ledger rows as the app role.

const root = path.resolve(__dirname, "..", "..", "..");
const OWNER_SIDE = /["'](?:@\/|(?:\.\.?\/)+)(?:lib\/schema\/runner\/)?(ownerPool|runner|execute|expandContract|ledger|engineAdapter|testing\/stubEngine)(?:\.ts)?["']/;
const SKIP = new Set(["node_modules", ".next", ".git", ".claude", ".worktrees", "coverage", "dist"]);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return SKIP.has(entry.name) ? [] : sourceFiles(full);
    return /\.(tsx?|mjs|js)$/.test(entry.name) ? [full] : [];
  });
}

describe("migration runner owner boundary", () => {
  it("only the runner, its tests and the worker script import the owner-side modules", () => {
    const offenders = ["app", "lib", "components", "middleware.ts", "scripts"]
      .flatMap((entry) => {
        const full = path.join(root, entry);
        try {
          return readdirSync(full) && sourceFiles(full);
        } catch {
          return entry.endsWith(".ts") ? [full] : [];
        }
      })
      .map((file) => path.relative(root, file).replace(/\\/g, "/"))
      .filter((file) => !file.startsWith("lib/schema/runner/") && file !== "scripts/schema-migration-worker.mjs")
      .filter((file) => {
        const text = readFileSync(path.join(root, file), "utf8");
        return /schema\/runner/.test(text) && OWNER_SIDE.test(text.replace(/\r/g, ""));
      });
    expect(offenders).toEqual([]);
  });

  it("the app-safe entry point exports only the request side", () => {
    const index = readFileSync(path.join(root, "lib/schema/runner/index.ts"), "utf8");
    const imports = [...index.matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1]);
    expect(imports).toEqual(["@/lib/schema/runner/request"]);
  });

  it("refuses to open the owner pool inside the CMS server", () => {
    expect(() => createOwnerPool({ NEXT_RUNTIME: "nodejs", POLYNOVEA_MIGRATION_DATABASE_URL: "postgres://x@localhost/db" })).toThrow(/cannot be opened inside the CMS server/);
  });

  it("waits at most 3 seconds for a lock, with a long statement timeout for scans and index builds", () => {
    const config = ownerPoolConfig({ POLYNOVEA_MIGRATION_DATABASE_URL: "postgres://x@localhost/db" });
    expect(config.lock_timeout).toBe(3_000);
    expect(config.statement_timeout).toBe(30 * 60_000);
    expect(config.max).toBe(2);
  });
});
