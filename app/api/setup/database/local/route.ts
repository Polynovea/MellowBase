import { DatabaseSetupError } from "@/lib/setup/database/errors";
import { LOCAL_SERVER_UNAVAILABLE, localServerHostForThisImage, localServerSettings, parseBackupChoice, runLocalServerSetup } from "@/lib/setup/database/localServer";
import { openDatabaseStep, readJsonBody, saveDatabaseConfig, startDatabaseRun } from "@/lib/setup/database/routeSupport";
import { setupJson } from "@/lib/setup/requestGuards";

/**
 * POST /api/setup/database/local with JSON {kind: "s3" | "azure" | "same-server", ...}: "On this
 * server". Starts the bundled PostgreSQL on the data disk, provisions it, and sets up pgBackRest; the
 * save happens only after stanza-create, check, a full backup and verify have passed. Streamed.
 *
 * The bundled database ships with the Phase 5 server image; until then this answers 501 with a plain
 * message, and the page shows the option as not available.
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
      // The backup worker's first job is a real restore test; it reads this flag (Phase 5 worker).
      recordRestoreTestPending: async () => {
        console.info("[setup/database] First backup verified; a restore test is due as the backup worker's first job.");
      },
    });
  });
}
