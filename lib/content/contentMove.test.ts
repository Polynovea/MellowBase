import { describe, expect, it, vi } from "vitest";
import { describeTableStatus, isTableShapeError, retryOnConflict, tableChangeState, tableStatusFromChange } from "@/lib/content/contentMove";

const failure = (code: string) => Object.assign(new Error("content_sync"), { code });

describe("retryOnConflict (backfill batches)", () => {
  it("runs a batch again after a deadlock or a serialization failure, with growing waits", async () => {
    const waits: number[] = [];
    const run = vi.fn()
      .mockRejectedValueOnce(failure("40P01"))
      .mockRejectedValueOnce(failure("40001"))
      .mockResolvedValueOnce("done");
    const retried: string[] = [];
    await expect(retryOnConflict(run, { sleep: async (ms) => { waits.push(ms); }, onRetry: (_, code) => retried.push(code) })).resolves.toBe("done");
    expect(run).toHaveBeenCalledTimes(3);
    expect(retried).toEqual(["40P01", "40001"]);
    // Exponential with jitter: 100 ms x [0.5, 1.5), then 200 ms x [0.5, 1.5).
    expect(waits[0]).toBeGreaterThanOrEqual(50);
    expect(waits[0]).toBeLessThan(150);
    expect(waits[1]).toBeGreaterThanOrEqual(100);
    expect(waits[1]).toBeLessThan(300);
  });

  it("gives up after three retries and throws the last error", async () => {
    const run = vi.fn().mockRejectedValue(failure("40P01"));
    await expect(retryOnConflict(run, { sleep: async () => undefined })).rejects.toMatchObject({ code: "40P01" });
    expect(run).toHaveBeenCalledTimes(4);
  });

  it("never retries other errors", async () => {
    for (const code of ["22P02", "23505", "55000", undefined]) {
      const run = vi.fn().mockRejectedValue(code ? failure(code) : new Error("boom"));
      await expect(retryOnConflict(run, { sleep: async () => undefined })).rejects.toBeTruthy();
      expect(run).toHaveBeenCalledTimes(1);
    }
  });
});

describe("a model's table part-way through a schema change", () => {
  const row = (id: string, stage: string, status: string, error_ref: string | null = null) => ({ id, stage, status, error_ref });

  it("a queued or running stage is in progress, whatever came before it", () => {
    expect(tableChangeState([row("l2", "expand", "pending"), row("l1", "expand", "failed", "e1")])).toEqual({ state: "in_progress", ledgerId: "l2", stage: "expand", status: "pending" });
    expect(tableChangeState([row("l3", "destructive", "awaiting_confirmation"), row("l2", "expand", "running")])).toEqual({ state: "in_progress", ledgerId: "l2", stage: "expand", status: "running" });
  });

  it("a failed latest expand means the table never got the model's fields; a superseded one does not count", () => {
    expect(tableChangeState([row("l2", "expand", "failed", "worker:abc")])).toEqual({ state: "failed", ledgerId: "l2", errorRef: "worker:abc" });
    expect(tableChangeState([row("l3", "expand", "superseded"), row("l2", "expand", "failed")])).toMatchObject({ state: "failed", ledgerId: "l2" });
    expect(tableChangeState([row("l3", "expand", "succeeded"), row("l2", "expand", "failed")])).toEqual({ state: "none" });
  });

  it("a deletion waiting for confirmation, a finished change or no change at all is not part-way", () => {
    expect(tableChangeState([row("l3", "destructive", "awaiting_confirmation"), row("l2", "expand", "succeeded")])).toEqual({ state: "none" });
    expect(tableChangeState([row("l2", "destructive", "failed"), row("l1", "expand", "succeeded")])).toEqual({ state: "none" });
    expect(tableChangeState([])).toEqual({ state: "none" });
  });

  it("maps to a content:move status and a plain sentence, never a SQLSTATE", () => {
    const running = tableStatusFromChange({ state: "in_progress", ledgerId: "l", stage: "expand", status: "running" }, "m_note");
    expect(running).toEqual({ status: "change_in_progress", table: "m_note", ledgerId: "l", stage: "expand", stageStatus: "running" });
    expect(describeTableStatus(running!)).toMatch(/being applied right now/);
    const queued = tableStatusFromChange({ state: "in_progress", ledgerId: "l", stage: "expand", status: "pending" }, "m_note")!;
    expect(describeTableStatus(queued)).toMatch(/waiting for the schema worker.*--wait/);
    const failed = tableStatusFromChange({ state: "failed", ledgerId: "l", errorRef: null }, "m_note")!;
    expect(describeTableStatus(failed)).toMatch(/failed/);
    expect(tableStatusFromChange({ state: "none" }, "m_note")).toBeNull();
    for (const status of [running!, queued, failed, { status: "exists", table: "m" } as const, { status: "requested", expandLedgerId: null } as const, { status: "no_schema_version" } as const]) {
      expect(describeTableStatus(status)).not.toMatch(/\b42703\b|select|insert/i);
    }
  });

  it("recognises the errors a table changing under a run produces", () => {
    expect(isTableShapeError({ code: "42703" })).toBe(true);
    expect(isTableShapeError({ code: "42P01" })).toBe(true);
    expect(isTableShapeError({ code: "40P01" })).toBe(false);
    expect(isTableShapeError(new Error("x"))).toBe(false);
  });
});

describe("content:move says why a model failed", async () => {
  const { describeSchemaProblems, moveErrorFields, schemaProblems } = await import("@/lib/content/contentMove");
  const { SchemaEngineError } = await import("@/lib/schema/engine/errors");
  const { columnForField } = await import("@/lib/schema/engine/columns");
  const certSchema = { name: "Phase 5 Collaboration Record", apiKey: "phase5_collab_cert", capability: "content_enabled", fields: [
    { key: "title", label: "Title", type: "short_text", required: true, localized: false, unique: false },
    { key: "notes", label: "Notes", type: "long_text", required: false, localized: false, unique: false },
  ] };

  it("a saved schema with an unknown field type is reported in plain words before anything is attempted", () => {
    const problems = schemaProblems(certSchema);
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.join(" ")).toMatch(/fields\.0\.type/);
    expect(describeSchemaProblems(problems)).toMatch(/^This model's saved schema is not valid \(.*\)\. Fix the model in the CMS/);
    expect(schemaProblems({ ...certSchema, fields: certSchema.fields.map((f) => ({ ...f, type: f.type === "short_text" ? "text" : f.type })) })).toEqual([]);
  });

  it("the schema engine refuses such a field with a coded, plain-words error (not a bare Error)", () => {
    let caught: unknown;
    try { columnForField(certSchema.fields[0] as never, "title"); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(SchemaEngineError);
    expect(moveErrorFields(caught)).toEqual({ code: "schema:invalid_plan", message: expect.stringMatching(/Field "title" has type "short_text"/) });
  });

  it("never a bare 'error': SQLSTATEs keep their code word, anything else carries its type and a hint", () => {
    expect(moveErrorFields(Object.assign(new Error("content_model_has_no_table"), { code: "P0002" }))).toEqual({ code: "P0002:content_model_has_no_table" });
    expect(moveErrorFields(Object.assign(new Error("relation x does not exist with value 'secret'"), { code: "42P01" }))).toEqual({ code: "42P01" });
    expect(moveErrorFields(new TypeError("boom"))).toEqual({ code: "error", errorType: "TypeError", hint: expect.stringMatching(/POLYNOVEA_DEBUG=1/) });
    expect(moveErrorFields("weird")).toMatchObject({ code: "error", errorType: "String" });
  });
});
