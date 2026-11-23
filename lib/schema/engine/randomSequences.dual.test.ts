// Phase 3's schema engine test: random sequences of model changes, applied and then reverted, on a
// table holding fixture data. After every change the table PostgreSQL reports must equal the plan's
// target shape, the recorded shape must match, and every value in a column the change did not touch
// (or only renamed, or converted without loss) must still be there.
import { afterAll, beforeAll, expect, it } from "vitest";
import { sql, type Kysely } from "kysely";
import type { DB } from "@/lib/db/generated/database";
import { getDb } from "@/lib/db/index";
import { applyDestructiveStage, applyExpandStage } from "@/lib/schema/engine/referenceExecutor.testing";
import { describeWithDatabase } from "@/lib/db/testing/database";
import {
  loadModelTable, prepareMigrationPlan, shapeForSchema,
  type FieldRename, type MigrationPlan, type PgColumnType,
} from "@/lib/schema/engine/index";
import { ownerDb, physicalOf, physicalShape, TEST_LIMITS, uniqueKey } from "@/lib/schema/engine/testing";
import type { CanonicalSchema, FieldDefinition } from "@/lib/schema/fields/types";

/** Small seeded PRNG (mulberry32): the same seed replays the same sequence. */
function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return { next, pick: <T,>(items: readonly T[]): T => items[Math.floor(next() * items.length)], chance: (p: number) => next() < p };
}

type Rand = ReturnType<typeof rng>;
const TYPES = ["text", "long_text", "integer", "number", "boolean", "date", "datetime", "json", "email", "relation"] as const;
const UNIQUE_OK = new Set<FieldDefinition["type"]>(["text", "long_text", "integer", "number", "email"]);
const DEFAULTS: Partial<Record<FieldDefinition["type"], unknown>> = {
  text: "d", long_text: "d", email: "d@example.test", integer: 7, number: 7.5, boolean: true, date: "2026-01-01", datetime: "2026-01-01T00:00:00.000Z", json: { d: 1 },
};

function randomField(r: Rand, key: string): FieldDefinition {
  const type = r.pick(TYPES);
  const field: FieldDefinition = { key, label: key, type, required: false, localized: false, unique: false };
  if (type === "relation") {
    field.relation = { targetModelApiKey: "other", cardinality: r.chance(0.8) ? "many_to_one" : "many_to_many", onDelete: r.pick(["block", "remove_reference"] as const) };
    return field;
  }
  // Required fields always carry a default (so existing rows can be backfilled); never also unique.
  if (r.chance(0.3)) { field.required = true; field.defaultValue = DEFAULTS[type]; }
  else if (UNIQUE_OK.has(type) && r.chance(0.3)) field.unique = true;
  else if (r.chance(0.3)) field.index = true;
  return field;
}

/** One random change to `schema`, plus the renames it implies. */
function mutate(r: Rand, schema: CanonicalSchema, counter: { n: number }): { next: CanonicalSchema; renames: FieldRename[] } {
  const fields = schema.fields.map((field) => ({ ...field }));
  const fresh = () => `f${(counter.n += 1)}`;
  const op = fields.length < 2 ? "add" : r.pick(["add", "add", "remove", "rename", "retype", "flags", "flags"] as const);
  const index = Math.floor(r.next() * fields.length);
  const renames: FieldRename[] = [];
  switch (op) {
    case "add":
      fields.push(randomField(r, fresh()));
      break;
    case "remove":
      fields.splice(index, 1);
      break;
    case "rename": {
      const to = fresh();
      if (fields[index].type !== "relation" || fields[index].relation?.cardinality === "many_to_one") renames.push({ from: fields[index].key, to });
      fields[index] = { ...fields[index], key: to, label: to };
      break;
    }
    case "retype":
      fields[index] = randomField(r, fields[index].key);
      break;
    case "flags": {
      const field = fields[index];
      if (field.type === "relation") {
        if (field.relation) field.relation = { ...field.relation, onDelete: field.relation.onDelete === "block" ? "remove_reference" : "block" };
        break;
      }
      const roll = r.pick(["required", "unique", "index"] as const);
      if (roll === "required") {
        field.required = !field.required;
        field.unique = false;
        field.defaultValue = field.required ? DEFAULTS[field.type] : undefined;
      } else if (roll === "unique" && UNIQUE_OK.has(field.type) && !field.required) field.unique = !field.unique;
      else field.index = !field.index;
      break;
    }
  }
  return { next: { ...schema, fields }, renames };
}

const VARIANTS = ["draft", "published"] as const;

/** A value per (row, column type) that is unique per row, so unique indexes always hold. */
function valueFor(type: PgColumnType, row: number, salt: number, entryIds: string[]): unknown {
  switch (type) {
    case "text": return `v${salt}_${row}`;
    case "jsonb": return JSON.stringify({ row, salt });
    case "numeric": return row + salt / 1000 + 0.25;
    case "bigint": return row + salt * 1000;
    case "boolean": return row % 2 === 0;
    case "date": return `2026-02-${String((row % 28) + 1).padStart(2, "0")}`;
    case "timestamptz": return new Date(Date.UTC(2026, 2, 1, 0, row)).toISOString();
    case "uuid": return entryIds[(row + 1) % entryIds.length];
  }
}

describeWithDatabase("schema engine: random model changes applied and reverted", (backend) => {
  let owner: Kysely<DB>;
  beforeAll(() => { owner = ownerDb(); });
  afterAll(async () => { await owner.destroy(); });

  for (const seed of [11, 2026, 90210]) {
    it(`seed ${seed}: every change and its revert leaves the table matching its shape, with data kept`, async () => {
      const r = rng(seed);
      const { workspaceId, adminUserId } = await backend.createWorkspace();
      const apiKey = uniqueKey("rand");
      const [model] = await backend.query<{ id: string }>("insert into content_models (workspace_id, name, api_key) values ($1, 'Random', $2) returning id", [workspaceId, apiKey]);
      const entryIds: string[] = [];
      for (let i = 0; i < 4; i += 1) {
        entryIds.push((await backend.query<{ id: string }>("insert into content_entries (workspace_id, content_model_id) values ($1, $2) returning id", [workspaceId, model.id]))[0].id);
      }
      const rows = entryIds.flatMap((entryId) => VARIANTS.map((variant) => ({ entryId, variant })));
      let salt = 0;
      let current: CanonicalSchema | null = null;

      const apply = async (target: CanonicalSchema, renames: FieldRename[], label: string): Promise<MigrationPlan> => {
        const result = await prepareMigrationPlan(getDb(), { workspaceId, model: { id: model.id, apiKey }, currentSchema: current, targetSchema: target, renames, limits: TEST_LIMITS });
        if (!result.ok) throw new Error(`${label}: ${result.problems.map((p) => p.message).join("; ")}`);
        const plan = result.plan;
        const expand = await applyExpandStage(owner, { plan, requestedBy: adminUserId, limits: TEST_LIMITS });
        if (expand.awaitingConfirmationId) await applyDestructiveStage(owner, { ledgerId: expand.awaitingConfirmationId, confirmation: apiKey, confirmedBy: adminUserId });
        current = target;
        expect(await physicalShape(backend.query, plan.table), label).toEqual(physicalOf(plan.targetShape));
        expect((await loadModelTable(getDb(), model.id))?.hash, label).toBe(plan.targetShapeHash);
        expect(plan.targetShape, label).toEqual(JSON.parse(JSON.stringify(shapeForSchema(plan.table, target))));
        return plan;
      };

      /** Fills every empty value (as the app role), so the next change runs over real data. */
      const fill = async (plan: MigrationPlan) => {
        salt += 1;
        const t = sql.id("content", plan.table);
        const columns = Object.values(plan.targetShape!.columns);
        for (const [index, row] of rows.entries()) {
          const names = columns.map((column) => sql.id(column.name));
          const values = columns.map((column) => sql`cast(${valueFor(column.pgType, index, salt, entryIds)} as ${sql.raw(column.pgType)})`);
          const keep = columns.map((column) => sql`${sql.id(column.name)} = coalesce(${t}.${sql.id(column.name)}, excluded.${sql.id(column.name)})`);
          const extraNames = names.length ? sql`, ${sql.join(names)}` : sql``;
          const extraValues = values.length ? sql`, ${sql.join(values)}` : sql``;
          const onConflict = keep.length ? sql`do update set ${sql.join(keep)}` : sql`do nothing`;
          await sql`insert into ${t} (_entry_id, _variant, _locale${extraNames}) values (${row.entryId}, ${row.variant}, 'en'${extraValues})
            on conflict (_entry_id, _variant, _locale) ${onConflict}`.execute(getDb());
        }
      };
      const snapshot = async (table: string, columns: string[]) => {
        const values = new Map<string, unknown[]>();
        for (const column of columns) {
          const result = await sql<{ v: string | null }>`select ${sql.id(column)}::text as v from ${sql.id("content", table)} order by _entry_id, _variant, _locale`.execute(owner);
          values.set(column, result.rows.map((row) => row.v));
        }
        return values;
      };
      /** Columns whose values must survive `plan`: untouched or renamed, same column type. Maps new name to old. */
      const survivors = (plan: MigrationPlan) => {
        const kept = new Map<string, string>();
        for (const [name, column] of Object.entries(plan.targetShape?.columns ?? {})) {
          const rename = plan.steps.find((s) => s.kind === "rename_column" && s.to === name);
          const old = rename && rename.kind === "rename_column" ? rename.from : name;
          const before = plan.baseShape?.columns[old];
          const replaced = plan.steps.some((s) => (s.kind === "replace_column" && s.column.name === name) || (s.kind === "change_type" && s.column === name));
          if (before && before.pgType === column.pgType && !replaced) kept.set(name, old);
        }
        return kept;
      };

      let plan = await apply({ name: "Random", apiKey, fields: [randomField(r, "f0")] }, [], "create");
      await fill(plan);
      const counter = { n: 0 };
      for (let step = 1; step <= 10; step += 1) {
        const before = current!;
        const { next, renames } = mutate(r, before, counter);
        const beforeValues = await snapshot(plan.table, Object.keys(plan.targetShape!.columns));

        plan = await apply(next, renames, `seed ${seed} step ${step} forward`);
        const kept = survivors(plan);
        const afterValues = await snapshot(plan.table, [...kept.keys()]);
        for (const [name, old] of kept) expect(afterValues.get(name), `step ${step} forward kept ${old}→${name}`).toEqual(beforeValues.get(old));

        // Revert. Deleted and renamed-away names are reserved for 30 days; let that time pass first.
        await backend.query("update schema_name_reservations set reserved_until = now() - interval '1 second' where content_model_id = $1", [model.id]);
        const revertValues = await snapshot(plan.table, Object.keys(plan.targetShape!.columns));
        const back = renames.map((rename) => ({ from: rename.to, to: rename.from }));
        plan = await apply(before, back, `seed ${seed} step ${step} revert`);
        const keptBack = survivors(plan);
        const revertedValues = await snapshot(plan.table, [...keptBack.keys()]);
        for (const [name, old] of keptBack) expect(revertedValues.get(name), `step ${step} revert kept ${old}→${name}`).toEqual(revertValues.get(old));

        // Then move forward again so the sequence keeps changing, and refill emptied columns.
        await backend.query("update schema_name_reservations set reserved_until = now() - interval '1 second' where content_model_id = $1", [model.id]);
        plan = await apply(next, renames, `seed ${seed} step ${step} reapply`);
        await fill(plan);
      }
    }, 120_000);
  }
});
