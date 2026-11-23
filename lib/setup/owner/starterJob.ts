import { createEntry, listEntries } from "@/lib/content/entryService";
import { createModel, listModels } from "@/lib/schema/modelService";
import { seedStarterContent, type StarterContentApi, type StarterContentResult } from "@/lib/setup/owner/starterContent.mjs";

/**
 * Starter content after setup: runs once the owner is committed and the CMS is running, as the new
 * owner, through the same services the CMS API uses. It is a separate job on purpose: a failure here
 * never rolls back the owner. The work is idempotent (starterContent.mjs), so it retries a few times
 * with a growing pause; if it still fails, the owner can run `npm run seed:starter` later.
 */

export const STARTER_RETRY_DELAYS_MS = [0, 5_000, 30_000, 120_000] as const;

export interface StarterTarget {
  workspaceId: string;
  actorAdminUserId: string;
}

function unwrap<T>(result: { ok: true; data: T } | { ok: false; error: string }): T {
  if (!result.ok) throw new Error(result.error);
  return result.data;
}

export function serviceStarterApi(target: StarterTarget): StarterContentApi {
  return {
    listModels: () => listModels(target.workspaceId),
    createModel: async (input) =>
      unwrap(await createModel({ workspaceId: target.workspaceId, description: input.description, icon: input.icon, proposedSchema: input.schema, createdBy: target.actorAdminUserId })).model,
    listEntries: (modelId) => listEntries(target.workspaceId, modelId),
    createEntry: async (input) =>
      unwrap(await createEntry({ workspaceId: target.workspaceId, modelId: input.modelId, data: input.data, actorAdminUserId: target.actorAdminUserId, changeSummary: input.changeSummary })).entry,
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms).unref?.());

/** Runs the job with retries. Resolves with the result, or null after the last failure (logged, never thrown). */
export async function runStarterContent(
  target: StarterTarget,
  options: { api?: StarterContentApi; delays?: readonly number[]; logger?: Pick<Console, "info" | "error"> } = {},
): Promise<StarterContentResult | null> {
  const api = options.api ?? serviceStarterApi(target);
  const delays = options.delays ?? STARTER_RETRY_DELAYS_MS;
  const logger = options.logger ?? console;
  for (let attempt = 0; attempt < delays.length; attempt += 1) {
    if (delays[attempt]) await sleep(delays[attempt]);
    try {
      const result = await seedStarterContent(api, { changeSummary: "Created by the setup wizard" });
      logger.info("[setup] Starter content is ready.");
      return result;
    } catch (error) {
      logger.error(`[setup] Starter content attempt ${attempt + 1} of ${delays.length} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  logger.error("[setup] Starter content was not created. The owner account is fine; run `npm run seed:starter` to add it.");
  return null;
}

/** Fire and forget, after the setup transaction has committed. */
export function scheduleStarterContent(target: StarterTarget): void {
  void runStarterContent(target);
}
