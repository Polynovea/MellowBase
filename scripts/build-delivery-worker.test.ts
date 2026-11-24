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

describe("the schema migration worker bundle", () => {
  it("builds; only it carries the owner pool (the delivery worker bundle never does)", async () => {
    const delivery = await buildWorker({ outFile: `${OUT}/delivery-worker.mjs` });
    const schema = await buildWorker({ input: "scripts/schema-migration-worker.mjs", outFile: `${OUT}/schema-migration-worker.mjs` });
    execFileSync(process.execPath, ["--check", schema.outFile]);
    expect(delivery.typeScriptModules).not.toContain("lib/schema/runner/ownerPool.ts");
    expect(schema.typeScriptModules).toContain("lib/schema/runner/ownerPool.ts");
    const deliveryText = readFileSync(delivery.outFile, "utf8");
    expect(deliveryText).not.toMatch(/owner_pool_in_app|polynovea-schema-runner/);
    expect(readFileSync(schema.outFile, "utf8")).toMatch(/polynovea-schema-runner/);
  }, 120_000);

  it("in setup mode (no config.enc, no database URL) it exits 3 and logs not_configured, in plain Node", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const empty = mkdtempSync(path.join(tmpdir(), "p4-schema-worker-"));
    const env: NodeJS.ProcessEnv = { NODE_ENV: "production", PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "", POLYNOVEA_CONFIG_DIR: empty };
    const { spawnSync } = await import("node:child_process");
    const run = spawnSync(process.execPath, ["--no-warnings", path.join(root, OUT, "schema-migration-worker.mjs")], { cwd: empty, env, encoding: "utf8", timeout: 60_000 });
    expect(run.status).toBe(3);
    expect(run.stdout).toMatch(/"event":"not_configured"/);
    expect(`${run.stdout}${run.stderr}`).not.toMatch(/postgres(ql)?:\/\//);
  }, 120_000);
});
