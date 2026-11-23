import { serverAuthProvider } from "@/lib/auth/settings";
import { getBuiltinAuth } from "@/lib/auth/betterAuth/instance";
import { isExposedAuthRequest } from "@/lib/auth/betterAuth/routes";

// Built-in auth endpoints (sign-in, MFA, passkeys, sessions). Only an allowlist reaches the library.
export const dynamic = "force-dynamic";

const notFound = () => Response.json({ success: false, data: null, error: "Not found" }, { status: 404 });

async function handle(request: Request): Promise<Response> {
  if (serverAuthProvider() !== "builtin" || !isExposedAuthRequest(request)) return notFound();
  return getBuiltinAuth().handler(request);
}

export const GET = handle;
export const POST = handle;
