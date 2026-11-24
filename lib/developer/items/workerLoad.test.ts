import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("the delivery worker can load the one permission check", () => {
  it("imports lib/developer/items/schedule.ts through the node loader (npm run worker:delivery)", () => {
    const out = execFileSync(process.execPath, [
      "--no-warnings", "--loader", "./scripts/phase12_75-node-loader.mjs", "-e",
      "import('./lib/developer/items/schedule.ts').then((m) => console.log(typeof m.scheduledPublishCheck))",
    ], { cwd: process.cwd(), encoding: "utf8", timeout: 60_000 });
    expect(out.trim().split("\n").at(-1)).toBe("function");
  }, 90_000);
});
