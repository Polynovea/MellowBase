import { assertMode, ModeError } from "@/lib/setup/mode";
import { guardSetupRequest, setupJson, withSetupHeaders } from "@/lib/setup/requestGuards";
import { requireSetupSession, SetupSessionError, setupSessionErrorResponse, type SetupSession } from "@/lib/setup/setupSession";
import { EnrolmentError } from "@/lib/setup/owner/enrolment";
import { FinaliseError } from "@/lib/setup/owner/finalise";

/**
 * The owner step's request handling, shared by its routes. Every POST, in this order:
 *   1. guardSetupRequest (HTTPS or loopback, own Origin, nothing secret in the URL),
 *   2. assertMode("setup") (404 on a finished install, 503 while the database is down),
 *   3. requireSetupSession (the cookie a correct setup code bought),
 * then reads a small JSON body and runs the action. Answers carry the setup headers (no-store,
 * no-referrer, frame-ancestors 'none'). Enrolment and finalise refusals are shown to the person as
 * they are; anything else is logged and answered with a generic message.
 */

const MAX_BODY_BYTES = 16 * 1024;
const GENERIC_ERROR = "Something went wrong on the server. Try again; if it keeps happening, the server log says what failed.";

export type OwnerAction = (session: SetupSession, body: Record<string, unknown>, request: Request) => Promise<unknown>;

async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  if (request.method === "GET") return {};
  const type = request.headers.get("content-type") ?? "";
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY_BYTES) return null;
  if (!request.body) return {};
  if (!/^application\/json\b/i.test(type)) return null;
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
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Runs one owner-step action behind every check. */
export async function handleOwnerRequest(request: Request, action: OwnerAction, options: { successHeaders?: Record<string, string> } = {}): Promise<Response> {
  if (request.method !== "GET") {
    const refused = guardSetupRequest(request);
    if (refused) return refused;
  }
  try {
    await assertMode("setup");
  } catch (error) {
    if (error instanceof ModeError) return withSetupHeaders(error.toResponse());
    throw error;
  }
  let session: SetupSession;
  try {
    session = requireSetupSession(request);
  } catch (error) {
    if (error instanceof SetupSessionError) return setupSessionErrorResponse(error);
    throw error;
  }

  const body = await readJson(request);
  if (body === null) return setupJson(400, { error: "The form sent something the server can't read. Reload the page and try again.", code: "SETUP_BAD_REQUEST" });

  try {
    const data = await action(session, body, request);
    return setupJson(200, { data: data ?? null }, options.successHeaders);
  } catch (error) {
    if (error instanceof EnrolmentError || error instanceof FinaliseError) return setupJson(error.status, { error: error.message, code: error.code });
    if (error instanceof SetupSessionError) return setupSessionErrorResponse(error);
    console.error("[setup] Owner step failed", { name: (error as Error)?.name, code: (error as { code?: string })?.code });
    return setupJson(500, { error: GENERIC_ERROR, code: "SETUP_FAILED" });
  }
}
