// The migration worker loads the schema engine with plain Node: strip-only type removal plus the
// project's "@/" resolver (scripts/phase12_75-node-loader.mjs). Strip-only mode refuses TypeScript
// that needs code generation (parameter properties, enums, namespaces, `import x = require`), which
// tsc and Vitest accept, so this test loads every engine module in a child Node process.
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ENGINE_DIR = path.join(process.cwd(), "lib", "schema", "engine");
const LOADER = "./scripts/phase12_75-node-loader.mjs";

describe("schema engine under plain Node (strip-only types)", () => {
  it("loads every engine module without a load error", () => {
    const modules = readdirSync(ENGINE_DIR).filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts")).sort();
    expect(modules).toContain("errors.ts");
    const script = `
      const failures = [];
      for (const name of ${JSON.stringify(modules)}) {
        try { await import("./lib/schema/engine/" + name); }
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
});
