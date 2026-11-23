import { setupJson } from "@/lib/setup/requestGuards";
import { clearSetupSessionCookie } from "@/lib/setup/setupSession";
import { OWNER_ACTIONS } from "@/lib/setup/owner/actions";
import { handleOwnerRequest } from "@/lib/setup/owner/http";

/**
 * POST /api/setup/owner/<action>: one step of the owner enrolment (lib/setup/owner/actions.ts).
 * handleOwnerRequest runs guardSetupRequest, assertMode("setup") and requireSetupSession before any
 * action. `finish` commits the owner and the installation row, then clears the setup cookie.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ action: string }> }): Promise<Response> {
  const { action } = await params;
  const run = Object.prototype.hasOwnProperty.call(OWNER_ACTIONS, action) ? OWNER_ACTIONS[action] : undefined;
  if (!run) return setupJson(404, { error: "Not found", code: "SETUP_NOT_FOUND" });
  return handleOwnerRequest(request, run, action === "finish" ? { successHeaders: { "Set-Cookie": clearSetupSessionCookie() } } : {});
}
