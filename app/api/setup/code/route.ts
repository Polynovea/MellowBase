import { checkAttempt, recordFailure, recordSuccess, sourceKey, type AttemptDecision } from "@/lib/setup/attemptLimiter";
import { guardSetupRequest, setupClientAddress, setupJson, setupTransport } from "@/lib/setup/requestGuards";
import { verifySetupCode } from "@/lib/setup/setupCode";
import { setupSessionCookie, startSetupSession } from "@/lib/setup/setupSession";

/**
 * POST /api/setup/code with JSON {"code": "..."}: checks the setup code and starts the setup
 * session (the __Host-polynovea-setup cookie). Order matters:
 *
 * 1. Request guards (HTTPS or loopback, own Origin, no code in the URL): refused before anything is
 *    read or counted.
 * 2. The attempt limiter for this source: a locked source is refused even with the right code.
 * 3. The code itself. Wrong codes are counted; a right one clears the source and takes over any
 *    earlier browser's session.
 *
 * The code is never logged, never echoed and never put in a URL.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Where the wizard goes once the code is accepted: the db-step lane's page. (Route files may only export handlers and route config.) */
const SETUP_NEXT_STEP = "/setup/database";
const MAX_BODY_BYTES = 2048;

const WRONG_CODE =
  "That code didn't work. Copy it from the server log exactly as printed. A code expires an hour after the server starts; restart the CMS to print a new one.";
const BAD_BODY = "Enter the setup code in the form on the setup page.";

async function readBody(request: Request): Promise<string | null> {
  const type = request.headers.get("content-type") ?? "";
  if (!/^application\/json\b/i.test(type)) return null;
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY_BYTES) return null;
  if (!request.body) return null;
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
  return Buffer.concat(chunks).toString("utf8");
}

function readCode(text: string | null): string | null {
  if (text === null) return null;
  try {
    const body = JSON.parse(text) as unknown;
    if (!body || typeof body !== "object") return null;
    const code = (body as { code?: unknown }).code;
    return typeof code === "string" && code.trim() !== "" ? code : null;
  } catch {
    return null;
  }
}

function waitResponse(decision: Extract<AttemptDecision, { allowed: false }>): Response {
  const seconds = Math.max(1, Math.ceil(decision.retryAfterMs / 1000));
  const minutes = Math.max(1, Math.ceil(seconds / 60));
  const error =
    decision.reason === "locked"
      ? `Too many wrong codes from your network. Wait ${minutes} minute${minutes === 1 ? "" : "s"}, then try again.`
      : "Setup is receiving a lot of wrong codes right now, so every attempt has to wait a minute. Try again shortly.";
  return setupJson(429, { error, code: decision.reason === "locked" ? "SETUP_LOCKED" : "SETUP_SLOWED" }, { "Retry-After": String(seconds) });
}

export async function POST(request: Request): Promise<Response> {
  const refused = guardSetupRequest(request);
  if (refused) return refused;
  // The guard has already established this; it is read again for the session record.
  const transport = setupTransport(request.headers) ?? "https";
  const source = sourceKey(setupClientAddress(request.headers));

  const decision = checkAttempt(source);
  if (!decision.allowed) return waitResponse(decision);

  const code = readCode(await readBody(request));
  if (code === null) return setupJson(400, { error: BAD_BODY, code: "SETUP_BAD_REQUEST" });

  if (!verifySetupCode(code)) {
    const next = recordFailure(source);
    console.warn(`[setup] Wrong setup code from ${source}.`);
    if (!next.allowed && next.reason === "locked") return waitResponse(next);
    return setupJson(401, { error: WRONG_CODE, code: "SETUP_CODE_WRONG" });
  }

  recordSuccess(source);
  const started = startSetupSession(transport);
  console.info(`[setup] Setup code accepted${started.tookOver ? "; the setup session in the other browser was ended" : ""}.`);
  return setupJson(200, { data: { next: SETUP_NEXT_STEP, tookOver: started.tookOver } }, { "Set-Cookie": setupSessionCookie(started.token) });
}
