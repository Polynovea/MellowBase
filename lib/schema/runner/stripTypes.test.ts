// The migration worker runs under plain Node: strip-only type removal plus the project's "@/" resolver
// (scripts/phase12_75-node-loader.mjs), exactly as `npm run worker:schema` starts it. Strip-only mode
// refuses TypeScript that tsc and Vitest accept (parameter properties, enums, namespaces), and the
// loader does not resolve a bare directory import, so this test loads every runner module, and starts
// the worker itself, in child Node processes.
import { execFileSync, spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const RUNNER_DIR = path.join(process.cwd(), "lib", "schema", "runner");
const LOADER = "./scripts/phase12_75-node-loader.mjs";

describe("migration runner under plain Node (strip-only types)", () => {
  it("loads every runner module without a load error", () => {
    const modules = readdirSync(RUNNER_DIR).filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts")).sort();
    expect(modules).toEqual(expect.arrayContaining(["engineAdapter.ts", "expandContract.ts", "ownerPool.ts", "runner.ts"]));
    const script = `
      const failures = [];
      for (const name of ${JSON.stringify(modules)}) {
        try { await import("./lib/schema/runner/" + name); }
        catch (error) { failures.push(name + ": " + String(error && error.message || error).split("\\n")[0]); }
      }
      process.stdout.write(JSON.stringify(failures));`;
    const output = execFileSync(process.execPath, ["--no-warnings", "--loader", LOADER, "--input-type=module", "-e", script], {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 60_000,
    });
    expect(JSON.parse(output.trim().split("\n").pop() ?? "[]")).toEqual([]);
  }, 90_000);

  it("starts the worker the way npm run worker:schema does, as far as connecting to the database", () => {
    // Port 1 on loopback refuses at once: everything before the connection (every module, the engine
    // adapter, the pool settings) has loaded and run.
    const result = spawnSync(process.execPath, ["--no-warnings", "--loader", LOADER, "scripts/schema-migration-worker.mjs", "--once"], {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 60_000,
      env: { ...process.env, POLYNOVEA_MIGRATION_DATABASE_URL: "postgres://nobody@127.0.0.1:1/none", DATABASE_URL: "", NEXT_RUNTIME: "" },
    });
    const output = `${result.stdout}\n${result.stderr}`;
    expect(output).not.toMatch(/strip-only|ERR_MODULE_NOT_FOUND|ERR_UNSUPPORTED|Cannot find module|SyntaxError|EISDIR/);
    expect(output).toMatch(/"event":"startup_failed","code":"ECONNREFUSED"/);
    expect(output).not.toContain("nobody@127.0.0.1");
    expect(result.status).not.toBe(0);
  }, 90_000);
});
