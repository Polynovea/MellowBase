import { NOT_CREATED_FOR_YOU, parseSecretRef, runCreatedForYouSetup } from "@/lib/setup/database/createdForYou";
import { openDatabaseStep, saveDatabaseConfig, startDatabaseRun } from "@/lib/setup/database/routeSupport";
import { cloudSecretReaders } from "@/lib/setup/database/secretReaders";
import { setupJson } from "@/lib/setup/requestGuards";

/**
 * POST /api/setup/database/created (no body): "Created for you". Reads the admin secret named by the
 * operator's POLYNOVEA_DB_SECRET_REF with the VM's own identity, then the same checks, roles,
 * migrations and save as a managed database, streamed. The secret is used once and never stored.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";


export async function POST(request: Request): Promise<Response> {
  const opened = await openDatabaseStep(request);
  if (opened instanceof Response) return opened;
  const { session } = opened;

  const secretRef = parseSecretRef(process.env.POLYNOVEA_DB_SECRET_REF);
  if (!secretRef) return setupJson(404, { error: NOT_CREATED_FOR_YOU, code: "SETUP_DATABASE_NOT_CREATED" });

  const held: string[] = [];
  return startDatabaseRun(session, (emit) => runCreatedForYouSetup({
    secretRef,
    readers: cloudSecretReaders(),
    emit,
    held,
    allowlist: process.env.POLYNOVEA_SETUP_DB_ALLOWLIST,
    saveConfig: (result) => saveDatabaseConfig(result, session),
  }), () => held);
}
