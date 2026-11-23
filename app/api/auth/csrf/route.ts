import { getServerIdentityProvider } from "@/lib/auth/server";
import { serverAuthProvider } from "@/lib/auth/settings";
import { csrfToken } from "@/lib/auth/requestSecurity";

// The CSRF token for the signed-in session (built-in auth). Bound to the session ID, so it changes
// at every sign-in and is useless with any other session. Readable only same-origin: browsers do
// not let another site read this response, and the cookie alone never produces it.
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const noStore = { "cache-control": "no-store" };
  if (serverAuthProvider() !== "builtin") return Response.json({ success: false, data: null, error: "Not found" }, { status: 404, headers: noStore });
  const { identity } = await getServerIdentityProvider().verifyRequest(req);
  const secret = process.env.POLYNOVEA_AUTH_SECRET;
  if (!identity?.sessionId || !secret) return Response.json({ success: false, data: null, error: "Not signed in" }, { status: 401, headers: noStore });
  return Response.json({ success: true, data: { token: csrfToken(identity.sessionId, secret) }, error: null }, { headers: noStore });
}
