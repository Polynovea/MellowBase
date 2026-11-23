import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LOCK_TIMEOUT_MS } from "@/lib/schema/runner/lockRetry";
import { column, shape } from "@/lib/schema/runner/testing/plans";
import { connect, RunnerHarness } from "@/lib/schema/runner/testing/dualFixtures";

// The plan's phase 3 test: a schema change while a 30-second query holds a lock. The change must wait
// and retry (3-second lock timeout, five retries with backoff), and never block other queries for
// longer than one lock timeout. Uses the real backoff (about 1, 2, 4, 8, 16 s).

const HOLD_SECONDS = 30;
const h = new RunnerHarness();
beforeAll(() => h.open());
afterAll(() => h.close());

describe("a schema change while a 30-second query holds a lock", () => {
  it("waits and retries, never queues other queries for more than the lock timeout, then succeeds", async () => {
    const model = await h.newModel();
    await h.createTable(model, [column("title", "text")]);
    const ids = await h.entries(model, 50);
    for (const id of ids) await h.owner.query(`insert into content.${model.table} (entry_id, locale, variant, title) values ($1, '', 'published', 'x')`, [id]);
    const ledgerId = await h.request(model, h.plan(model, shape(model.table, [column("title", "text"), column("views", "bigint")]),
      [{ kind: "add_column", stage: "expand", column: column("views", "bigint") }]));

    // A reader holding ACCESS SHARE on the table for 30 seconds (a long report, say).
    const holder = await connect("app");
    const prober = await connect("app");
    const modelProber = await connect("app");
    try {
      await holder.query("begin");
      await holder.query(`select count(*) from content.${model.table}`);
      const holding = holder.query(`select pg_sleep(${HOLD_SECONDS})`).then(() => holder.query("commit"));
      const heldSince = Date.now();

      // Other queries keep running the whole time; record how long each one waits. Readers of the
      // table, and an app transaction that reads and updates the model's own row (the gate locks
      // content_models FOR UPDATE, but only in short transactions of its own).
      const latencies: number[] = [];
      const modelLatencies: number[] = [];
      let done = false;
      const probing = (async () => {
        while (!done) {
          const started = Date.now();
          await prober.query(`select title from content.${model.table} where entry_id = $1`, [ids[0]]);
          latencies.push(Date.now() - started);
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      })();
      const modelProbing = (async () => {
        while (!done) {
          const started = Date.now();
          await modelProber.query("begin");
          await modelProber.query("select name from content_models where id = $1", [model.modelId]);
          await modelProber.query("update content_models set name = name where id = $1", [model.modelId]);
          await modelProber.query("commit");
          modelLatencies.push(Date.now() - started);
          await new Promise((resolve) => setTimeout(resolve, 150));
        }
      })();

      const outcome = await h.run(model, { retry: undefined });
      const finishedAfter = Date.now() - heldSince;
      done = true;
      await Promise.all([probing, modelProbing, holding]);

      expect(outcome).toEqual({ ledgerId, outcome: "succeeded" });
      // It could only finish once the 30-second lock was gone.
      expect(finishedAfter).toBeGreaterThanOrEqual((HOLD_SECONDS - 1) * 1000);
      const run = await h.runRow(ledgerId);
      expect(run.lock_retries).toBeGreaterThanOrEqual(3);
      expect(run.lock_retries).toBeLessThanOrEqual(5);
      expect(run.step_log[0]).toMatchObject({ kind: "add_column", lockRetries: run.lock_retries });
      expect(await h.columns(model)).toHaveProperty("views");

      // Readers never waited longer than one lock timeout (plus scheduling slack), and kept going.
      expect(latencies.length).toBeGreaterThan(40);
      expect(Math.max(...latencies)).toBeLessThan(LOCK_TIMEOUT_MS + 1_500);
      expect(modelLatencies.length).toBeGreaterThan(30);
      expect(Math.max(...modelLatencies)).toBeLessThan(3_500);
    } finally {
      await holder.end().catch(() => undefined);
      await prober.end().catch(() => undefined);
      await modelProber.end().catch(() => undefined);
    }
  }, 120_000);
});
