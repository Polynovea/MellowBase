import { parseManagedDatabaseInput } from "@/lib/setup/database/checks";
import { DatabaseSetupError } from "@/lib/setup/database/errors";
import { runManagedDatabaseSetup } from "@/lib/setup/database/flow";
import { openDatabaseStep, readJsonBody, saveDatabaseConfig, startDatabaseRun } from "@/lib/setup/database/routeSupport";
import { setupJson } from "@/lib/setup/requestGuards";

/**
 * POST /api/setup/database/managed with JSON {hostname, port, database, user, password}: the five
 * checks, roles, migrations and the save, streamed as server-sent events (read with fetch).
 *
 * The admin password lives only in this request: it is never logged, stored or put in an event, and
 * it is dropped as soon as the admin login has signed in.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const opened = await openDatabaseStep(request);
  if (opened instanceof Response) return opened;
  const { session } = opened;

  const body = await readJsonBody(request);
  let input;
  try {
    input = parseManagedDatabaseInput(body);
  } catch (error) {
    if (error instanceof DatabaseSetupError) return setupJson(400, { error: error.message, code: "SETUP_DATABASE_INPUT" });
    throw error;
  }
  // Drop the parsed body's own reference to the password; `input` is the only holder from here.
  if (body && typeof body === "object") delete (body as { password?: unknown }).password;

  const held: string[] = [];
  return startDatabaseRun(session, (emit) => runManagedDatabaseSetup(input, {
    emit,
    held,
    allowlist: process.env.POLYNOVEA_SETUP_DB_ALLOWLIST,
    saveConfig: (result) => saveDatabaseConfig(result, session),
  }), () => held);
}
