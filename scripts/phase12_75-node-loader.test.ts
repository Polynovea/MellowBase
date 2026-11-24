import { execFileSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

// The certification scripts and content:move load lib/ through this loader and Node's type
// stripping, not through the bundler. Load the modules those scripts reach and fail on any
// import Node rejects (TypeScript it cannot strip, JSON without an import attribute, ...).
const repo = path.resolve(__dirname, "..");
const MODULES = ["lib/system/systemProbes.ts", "lib/setup/database/errors.ts", "lib/setup/owner/finalise.ts"];

describe("scripts/phase12_75-node-loader.mjs", () => {
  it("loads lib modules the scripts use, including local JSON imports", () => {
    const imports = MODULES.map((file) => `await import(${JSON.stringify(pathToFileURL(path.join(repo, file)).href)});`).join(" ");
    const output = execFileSync(
      process.execPath,
      ["--experimental-strip-types", "--no-warnings", "--loader", "./scripts/phase12_75-node-loader.mjs", "--input-type=module", "-e", `${imports} console.log("loaded");`],
      { cwd: repo, encoding: "utf8", timeout: 60_000 },
    );
    expect(output.trim()).toBe("loaded");
  }, 70_000);
});
