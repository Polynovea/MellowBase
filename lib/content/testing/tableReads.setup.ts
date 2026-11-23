// TEST ONLY. Setup for `npm run test:dual:tables`: the existing content tests, run with every model's
// reads switched to its table. Each model a test creates or changes through modelService is brought up
// the production way (schema change requested as the app role, run by the migration worker, then
// backfilled, verified and switched; see tableMove.ts), so every read those tests make of current
// content comes from the model tables. No test file is copied or changed.
import { afterAll, vi } from "vitest";
import { closeTableMoveSession } from "@/lib/content/testing/tableMove";

vi.mock("@/lib/schema/modelService", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/schema/modelService")>();
  const { bringModelTableUp } = await import("@/lib/content/testing/tableMove");
  const bringUp = async (workspaceId: string, modelId: string, actor: string | null) => {
    const result = await bringModelTableUp({ workspaceId, modelId, actor, switchReads: true });
    if (!result.verify.matched) throw new Error(`[test:dual:tables] model ${modelId} did not match: ${JSON.stringify(result.verify.mismatches)}`);
  };
  return {
    ...real,
    createModel: (async (params) => {
      const result = await real.createModel(params);
      if (result.ok) await bringUp(params.workspaceId, result.data.model.id, params.createdBy);
      return result;
    }) as typeof real.createModel,
    applyChange: (async (params) => {
      const result = await real.applyChange(params);
      if (result.ok && result.data.applied) await bringUp(params.model.workspace_id, params.model.id, params.actorAdminUserId);
      return result;
    }) as typeof real.applyChange,
  };
});

afterAll(async () => {
  await closeTableMoveSession();
});
