import { readInstallConfigSync, writeConfig, generateSecret } from "@/lib/setup/configStore";
import { assertMode, ModeError, reloadInstallConfig } from "@/lib/setup/mode";
import { guardSetupRequest, setupJson, withSetupHeaders } from "@/lib/setup/requestGuards";
import { requireSetupSession, setSetupState, SetupSessionError, setupSessionErrorResponse, type SetupSession } from "@/lib/setup/setupSession";
import type { DatabaseMode, ProvisionedDatabase } from "./provision";
import { databaseStepLimits, SETUP_ALREADY_RUNNING, SETUP_RUNS_EXHAUSTED, setupEventStream, type SetupEvent } from "./stream";

/**
 * What every database-step route does before anything else, in this order:
 * 1. guardSetupRequest: HTTPS or loopback, our own Origin, POST, nothing secret in the URL;
 * 2. requireSetupSession: the browser entered the setup code;
 * 3. assertMode("setup"): the install is not finished (404 once it is).
 */

export interface DatabaseStepState {
  databaseMode: DatabaseMode;
  completedAt: string;
}

declare module "@/lib/setup/setupSession" {
  interface SetupSessionState {
    database: DatabaseStepState;
  }
}

export async function openDatabaseStep(request: Request): Promise<{ session: SetupSession } | Response> {
  const refused = guardSetupRequest(request);
  if (refused) return refused;
  let session: SetupSession;
  try {
    session = requireSetupSession(request);
  } catch (error) {
    if (error instanceof SetupSessionError) return setupSessionErrorResponse(error);
    throw error;
  }
  try {
    await assertMode("setup");
  } catch (error) {
    if (error instanceof ModeError) return withSetupHeaders(error.toResponse());
    throw error;
  }
  return { session };
}

const MAX_BODY_BYTES = 8 * 1024;

/** The request's JSON body (at most 8 KB), or null when it is missing, too big or not JSON. */
export async function readJsonBody(request: Request): Promise<unknown | null> {
  if (!/^application\/json\b/i.test(request.headers.get("content-type") ?? "")) return null;
  if (Number(request.headers.get("content-length") ?? "0") > MAX_BODY_BYTES || !request.body) return null;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    return null;
  }
}

/**
 * Saves the result through gate-config's writeConfig, keeping the auth secret if an earlier run of
 * this step already saved one, then tells the mode check to read the new settings.
 */
export async function saveDatabaseConfig(result: ProvisionedDatabase, session: SetupSession): Promise<void> {
  let authSecret: string | null = null;
  try {
    authSecret = readInstallConfigSync()?.authSecret ?? null;
  } catch {
    authSecret = null; // an unreadable earlier file is replaced
  }
  await writeConfig({
    v: 1,
    databaseMode: result.databaseMode,
    database: result.database,
    roles: result.roles,
    authSecret: authSecret ?? generateSecret(32),
    backupRepoPassword: result.backupRepoPassword ?? null,
  });
  reloadInstallConfig();
  try {
    setSetupState(session, "database", { databaseMode: result.databaseMode, completedAt: new Date().toISOString() });
  } catch {
    // Another browser took over meanwhile; the saved configuration is what counts.
  }
}

/**
 * Starts one provisioning run: per-session rate limit, then the install-wide run lock (one run at a
 * time, across sessions and options), then the event stream. The lock is released when the run ends.
 */
export function startDatabaseRun(
  session: SetupSession,
  run: (emit: (event: SetupEvent) => void) => Promise<unknown>,
  secrets: () => readonly string[] = () => [],
): Response {
  const limits = databaseStepLimits();
  if (!limits.runs.allow(session.id)) return setupJson(429, { error: SETUP_RUNS_EXHAUSTED, code: "SETUP_DATABASE_RATE_LIMITED" }, { "Retry-After": "120" });
  const release = limits.runLock.acquire(session.id);
  if (!release) return setupJson(409, { error: SETUP_ALREADY_RUNNING, code: "SETUP_DATABASE_RUNNING" });
  return withSetupHeaders(setupEventStream(async (emit) => {
    await run(emit);
  }, { secrets, onFinish: release }));
}
