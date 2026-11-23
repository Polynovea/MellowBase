import { describe, expect, it } from "vitest";
import { describeWithDatabase } from "@/lib/db/testing/database";
import { dryRunSchemaPromotion, exportSchemaBundle, promoteSchemaBundle } from "@/lib/developer/schemaDeliveryService";
import { runGovernedImport } from "@/lib/developer/importService";
import { createModel } from "@/lib/schema/modelService";
import type { DeveloperApiContext } from "@/lib/developer/apiAuth";
const schemaV1 = { name: "Note", apiKey: "note", fields: [{ key: "title", label: "Title", type: "text", required: true }] };

describeWithDatabase("developer schema delivery and import runs", (backend) => {
  it("records schema delivery dry runs and promotions with their audit events", async () => {
    const { workspaceId, adminUserId } = await backend.createWorkspace();
    const created = await createModel({ workspaceId, createdBy: adminUserId, proposedSchema: schemaV1 });
    if (!created.ok) throw new Error(created.error);
    const context = { workspaceId, actorAdminUserId: adminUserId };

    const bundle = await exportSchemaBundle(workspaceId);
    const noop = await dryRunSchemaPromotion(context, bundle);
    expect(noop.hasChanges).toBe(false);
    const changed = { ...bundle, models: bundle.models.map((m) => ({ ...m, schema: { ...m.schema, fields: [...m.schema.fields, { key: "body", label: "Body", type: "text" }] } })) };
    const dry = await dryRunSchemaPromotion(context, changed);
    expect(dry.hasChanges).toBe(true);
    const promoted = await promoteSchemaBundle({ context, bundle: changed });
    expect(promoted).toMatchObject({ applied: true, status: "applied", results: [{ apiKey: "note", status: "updated", version: 2 }] });

    const runs = await backend.query<{ operation: string; status: string; actor_admin_user_id: string; completed_at: string | null }>(
      "select operation, status, actor_admin_user_id, completed_at from developer_schema_runs where workspace_id = $1 order by created_at, operation",
      [workspaceId],
    );
    expect(runs.map((r) => `${r.operation}:${r.status}`)).toEqual(["dry_run:applied", "dry_run:planned", "promotion:applied"]);
    expect(runs.every((r) => r.actor_admin_user_id === adminUserId && r.completed_at)).toBe(true);
    const events = await backend.query<{ action: string }>("select action from platform_audit_events where workspace_id = $1 and entity_type = 'developer_schema_run' order by created_at, action", [workspaceId]);
    expect(events.map((e) => e.action)).toEqual(["schema.schema.dry_run", "schema.schema.dry_run", "schema.schema.promotion"]);
  });

  it("records import dry runs and refuses a commit with invalid rows", async () => {
    const { workspaceId, adminUserId } = await backend.createWorkspace();
    const created = await createModel({ workspaceId, createdBy: adminUserId, proposedSchema: schemaV1 });
    if (!created.ok) throw new Error(created.error);
    const context = { workspaceId, actorAdminUserId: adminUserId, tokenId: null } as unknown as DeveloperApiContext;

    const dry = await runGovernedImport({ context, modelApiKey: "note", format: "csv", content: "title\nFirst\n\nSecond\n", sourceName: "notes.csv" });
    expect(dry).toMatchObject({ mode: "dry_run", total: 2, valid: 2, invalid: 0 });
    const refused = await runGovernedImport({ context, modelApiKey: "note", format: "json", content: [{ title: "ok" }, { nope: 1 }], commit: true });
    expect(refused).toMatchObject({ mode: "commit", committed: false, total: 2, succeeded: 0, failed: 1 });

    const runs = await backend.query<{ mode: string; status: string; total_rows: number; failed_rows: number; source_name: string | null; result_json: Record<string, unknown> }>(
      "select mode, status, total_rows, failed_rows, source_name, result_json from developer_import_runs where workspace_id = $1 order by created_at",
      [workspaceId],
    );
    expect(runs).toEqual([
      { mode: "dry_run", status: "completed", total_rows: 2, failed_rows: 0, source_name: "notes.csv", result_json: { mapping: {}, dryRun: true } },
      { mode: "commit", status: "failed", total_rows: 2, failed_rows: 1, source_name: null, result_json: { reason: "validation_failed_before_commit" } },
    ]);
    await expect(runGovernedImport({ context, modelApiKey: "missing", format: "json", content: [] })).rejects.toThrow("Active content model not found");
  });

  it("keeps runs in their own workspace", async () => {
    const a = await backend.createWorkspace();
    const b = await backend.createWorkspace();
    const created = await createModel({ workspaceId: a.workspaceId, createdBy: a.adminUserId, proposedSchema: schemaV1 });
    if (!created.ok) throw new Error(created.error);
    await expect(runGovernedImport({ context: { workspaceId: b.workspaceId, actorAdminUserId: b.adminUserId } as unknown as DeveloperApiContext, modelApiKey: "note", format: "json", content: [] })).rejects.toThrow("Active content model not found");
    expect(await backend.query("select 1 from developer_import_runs where workspace_id = $1", [b.workspaceId])).toEqual([]);
  });
});
