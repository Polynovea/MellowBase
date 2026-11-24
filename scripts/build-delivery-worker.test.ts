import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildWorker, isExternal } from "./build-delivery-worker.mjs";

const root = process.cwd();
const OUT = "dist/test-bundles";

/** Runs an ESM snippet in plain Node: no loader, no type stripping flags, cwd = repo root. */
const plainNode = (code: string) => execFileSync(process.execPath, ["--no-warnings", "--input-type=module", "-e", code], { cwd: root, encoding: "utf8", timeout: 60_000 });

describe("the delivery worker bundle (what the image runs)", () => {
  it("keeps npm packages external and inlines the repo's own files", () => {
    for (const id of ["pg", "kysely", "@aws-sdk/client-s3", "node:fs"]) expect(isExternal(id)).toBe(true);
    for (const id of ["./x.mjs", "../lib/developer/items/schedule.ts", "@/lib/db/index", "D:\\repo\\x.ts", "/abs/x.ts"]) expect(isExternal(id)).toBe(false);
  });

  it("builds, passes node --check, and carries no TypeScript or alias imports", async () => {
    const { outFile, typeScriptModules } = await buildWorker({ outFile: `${OUT}/delivery-worker.mjs` });
    expect(typeScriptModules).toEqual(expect.arrayContaining(["lib/developer/items/schedule.ts", "lib/developer/items/access.ts", "lib/schema/modelPolicy.ts"]));
    execFileSync(process.execPath, ["--check", outFile]);
    const text = readFileSync(outFile, "utf8");
    expect(text).not.toMatch(/(?:from\s+|import\s*\()["'][^"']*\.ts["']/);
    expect(text).not.toMatch(/(?:from\s+|import\s*\()["']@\//);
    expect(text).toContain("scheduledPublishCheck");
  }, 120_000);

  it("in plain Node, the bundled permission check runs and refuses a scheduler with no rights", async () => {
    await buildWorker({ input: "lib/developer/items/schedule.ts", outFile: `${OUT}/schedule.mjs` });
    const bundle = path.join(root, OUT, "schedule.mjs").split(path.sep).join("/");
    const out = plainNode(`
      import { Kysely, DummyDriver, PostgresAdapter, PostgresIntrospector, PostgresQueryCompiler } from "kysely";
      const { scheduledPublishCheck } = await import("file:///${bundle.replace(/^\//, "")}");
      // A database with no rows: the scheduler is no active member, so nothing may be published.
      const db = new Kysely({ dialect: { createAdapter: () => new PostgresAdapter(), createDriver: () => new DummyDriver(), createIntrospector: (k) => new PostgresIntrospector(k), createQueryCompiler: () => new PostgresQueryCompiler() } });
      const none = await scheduledPublishCheck(db, "ws", null, "release");
      const stranger = await scheduledPublishCheck(db, "ws", "00000000-0000-4000-8000-000000000001", "release");
      console.log(JSON.stringify({ none, stranger }));
    `);
    expect(JSON.parse(out.trim().split("\n").at(-1)!)).toEqual({
      none: { ok: false, reason: "no_scheduler" },
      stranger: { ok: false, reason: "scheduler_not_member" },
    });
  }, 120_000);
});
