import { writeFile } from "node:fs/promises";
import path from "node:path";
import { dataRoot } from "@/lib/system/serverHost.mjs";
import { DatabaseSetupError } from "@/lib/setup/database/errors";
import { LOCAL_SERVER_UNAVAILABLE, localServerHostForThisImage, localServerSettings, parseBackupChoice, runLocalServerSetup } from "@/lib/setup/database/localServer";
import { openDatabaseStep, readJsonBody, saveDatabaseConfig, startDatabaseRun } from "@/lib/setup/database/routeSupport";
import { setupJson } from "@/lib/setup/requestGuards";

/**
 * POST /api/setup/database/local with JSON {kind: "s3" | "azure" | "same-server", ...}: "On this
 * server". Starts the bundled PostgreSQL on the data disk, provisions it, and sets up pgBackRest; the
 * save happens only after stanza-create, check, a full backup and verify have passed. Streamed.
 *
 * The bundled database ships only in the Polynovea server image (lib/setup/database/localServerImage.ts).
 * On any other server this answers 501 with a plain message, and the page shows the option as not
 * available.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const opened = await openDatabaseStep(request);
  if (opened instanceof Response) return opened;
  const { session } = opened;

  const host = localServerHostForThisImage();
  if (!host) return setupJson(501, { error: LOCAL_SERVER_UNAVAILABLE, code: "SETUP_DATABASE_LOCAL_UNAVAILABLE" });

  let backup;
  try {
    backup = parseBackupChoice(await readJsonBody(request));
  } catch (error) {
    if (error instanceof DatabaseSetupError) return setupJson(400, { error: error.message, code: "SETUP_DATABASE_INPUT" });
    throw error;
  }

  return startDatabaseRun(session, async (emit) => {
    await runLocalServerSetup({
      host,
      backup,
      ...localServerSettings(),
      emit,
      saveConfig: (result) => saveDatabaseConfig(result, session),
      // The worker runs a real restore test as soon as it sees this marker (lib/system/restoreTest.mjs).
      recordRestoreTestPending: async () => {
        await writeFile(path.posix.join(dataRoot(), "restore-test-due"), `${new Date().toISOString()}
`, { mode: 0o600 });
        console.info("[setup/database] First backup verified; the worker runs a restore test next.");
      },
    });
  });
}
