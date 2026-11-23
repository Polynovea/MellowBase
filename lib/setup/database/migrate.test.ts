import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { listMigrationFiles, MIGRATION_LOCK_KEY, runMigrations } from "@/scripts/run-migrations.mjs";
import { migrateAsOwner, MigrationLockError, type MigrationEvent } from "./migrate";
import { fakeClient, type Route } from "./testFakes";

function repo(files: Record<string, string>) {
  const root = mkdtempSync(path.join(tmpdir(), "migrations-"));
  mkdirSync(path.join(root, "supabase", "migrations"), { recursive: true });
  for (const [name, sql] of Object.entries(files)) writeFileSync(path.join(root, "supabase", "migrations", name), sql);
  return root;
}

function db(options: { locked?: boolean; applied?: Record<string, string>; failOn?: string } = {}) {
  const routes: Route[] = [
    [/pg_try_advisory_lock/, () => ({ rows: [{ locked: !options.locked }] })],
    [/unnest\(\$1::text\[\]\)/, () => ({ rows: [] })],
    [/ledger_exists/, () => ({ rows: [{ ledger_exists: true, core_exists: true }] })],
    [/select checksum_sha256/, (params) => ({ rows: options.applied?.[params[0] as string] ? [{ checksum_sha256: options.applied[params[0] as string] }] : [] })],
  ];
  if (options.failOn) routes.unshift([new RegExp(options.failOn), () => new Error("syntax error at or near")]);
  return fakeClient(routes);
}

describe("runMigrations as a module", () => {
  it("applies in order under the advisory lock, reports each file, skips applied ones and unlocks", async () => {
    const root = repo({ "0002_b.sql": "create table b();", "0001_a.sql": "create table a();", "notes.md": "x" });
    const applied = { "0001_a.sql": createHash("sha256").update("create table a();").digest("hex") };
    const fake = db({ applied });
    const events: MigrationEvent[] = [];
    const result = await migrateAsOwner(fake.client, { root, emit: (event) => events.push(event) });
    expect(result).toEqual({ applied: ["0002_b.sql"], skipped: ["0001_a.sql"] });
    expect(events.map((e) => `${e.index}/${e.total} ${e.filename} ${e.status}`)).toEqual(["1/2 0001_a.sql skipped", "2/2 0002_b.sql running", "2/2 0002_b.sql applied"]);
    const lock = fake.statements.findIndex((sql) => sql.includes("pg_try_advisory_lock"));
    const unlock = fake.statements.findIndex((sql) => sql.includes("pg_advisory_unlock"));
    expect(lock).toBe(0);
    expect(fake.params[lock]).toEqual([MIGRATION_LOCK_KEY]);
    expect(unlock).toBe(fake.statements.length - 1);
    expect(fake.statements).toContain("create table b();");
  });

  it("refuses at once when another process holds the lock", async () => {
    const fake = db({ locked: true });
    await expect(migrateAsOwner(fake.client, { root: repo({ "0001_a.sql": "select 1;" }), emit: () => {} })).rejects.toBeInstanceOf(MigrationLockError);
    expect(fake.statements.some((sql) => sql === "BEGIN")).toBe(false);
  });

  it("refuses a second run in the same server while one is going", async () => {
    const root = repo({ "0001_a.sql": "select pg_sleep(0);" });
    let release!: () => void;
    const slow = db();
    const original = slow.client.query.bind(slow.client) as (text: string, values?: unknown[]) => Promise<unknown>;
    (slow.client as unknown as { query: typeof original }).query = async (text, values) => {
      if (text === "select pg_sleep(0);") await new Promise<void>((resolve) => { release = resolve; });
      return original(text, values);
    };
    const first = runMigrations(slow.client, { root });
    await new Promise((resolve) => setTimeout(resolve, 10));
    await expect(runMigrations(db().client, { root })).rejects.toThrow(/already in progress in this server/);
    release();
    await first;
    // Once finished, the next run may start.
    await expect(runMigrations(db().client, { root })).resolves.toMatchObject({ applied: ["0001_a.sql"] });
  });

  it("rolls back, reports the failed file and still unlocks", async () => {
    const fake = db({ failOn: "^create table broken" });
    const events: MigrationEvent[] = [];
    await expect(migrateAsOwner(fake.client, { root: repo({ "0001_x.sql": "create table broken();" }), emit: (e) => events.push(e) })).rejects.toThrow();
    expect(events.at(-1)).toMatchObject({ filename: "0001_x.sql", status: "failed" });
    expect(fake.statements).toContain("ROLLBACK");
    expect(fake.statements.at(-1)).toContain("pg_advisory_unlock");
  });

  it("refuses a changed applied migration", async () => {
    const fake = db({ applied: { "0001_a.sql": "0".repeat(64) } });
    await expect(migrateAsOwner(fake.client, { root: repo({ "0001_a.sql": "select 1;" }), emit: () => {} })).rejects.toThrow(/checksum mismatch/);
  });

  it("lists only numbered SQL files, sorted", () => {
    const root = repo({ "0010_b.sql": "", "0002_a.sql": "", "README.md": "", "x_0003.sql": "" });
    expect(listMigrationFiles(root).map((file) => path.basename(file))).toEqual(["0002_a.sql", "0010_b.sql"]);
  });
});
