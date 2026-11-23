import type { RequestIdentity, User } from "@/lib/auth/provider";
import { hasModuleAccess, hasModuleWriteAccess, normalizeAdminUser, type AdminModule } from "@/lib/admin/access";
import type { AdminUser } from "@/lib/admin/types";
import { createServiceRoleClient } from "@/lib/admin/serviceRole";
import { postgresAdminProfileStore, resolveAdminProfile, supabaseAdminProfileStore } from "@/lib/admin/profileResolution";
import { usesDirectPostgres } from "@/lib/db/backend";
import { getServerIdentityProvider } from "@/lib/auth/server";
import { csrfProblem, needsStepUp, requiredAuthenticators, securityResponse } from "@/lib/auth/requestSecurity";

export interface AdminRequestOptions {
  requireMaster?: boolean;
  requiredModule?: AdminModule | AdminModule[];
  requiredWriteModule?: AdminModule | AdminModule[];
  /** Sensitive action: the user must have signed in within the last 10 minutes. */
  stepUp?: boolean;
  /**
   * Let an owner or admin without the required second factors through (only the profile read the
   * admin UI needs to send them to set one up).
   */
  allowWithoutMfa?: boolean;
}

/** CSRF settings for cookie credentials, from the built-in auth's environment. */
function csrfSettings(): { publicOrigin: string; secret: string } | null {
  const url = process.env.POLYNOVEA_PUBLIC_URL;
  const secret = process.env.POLYNOVEA_AUTH_SECRET;
  if (!url || !secret) return null;
  try {
    return { publicOrigin: new URL(url).origin, secret };
  } catch {
    return null;
  }
}

export interface AdminRequestContext {
  user: User;
  profile: AdminUser;
  /** The verified credential: session, transport and when the user last authenticated. */
  identity: RequestIdentity;
}

const failure = (status: number, error: string) => ({
  error: Response.json({ success: false, data: null, error, timestamp: new Date().toISOString() }, { status }),
});

export async function requireAdminRequest(
  req: Request,
  options: AdminRequestOptions = {},
): Promise<{ data?: AdminRequestContext; error?: Response }> {
  let identity: RequestIdentity | null;
  try {
    const verified = await getServerIdentityProvider().verifyRequest(req);
    if (!verified.identity) {
      const missing = verified.error?.message.startsWith("Missing");
      return failure(401, missing ? "Not signed in" : "Invalid session");
    }
    identity = verified.identity;
  } catch {
    // A misconfigured provider (for example no Supabase service key) is a server fault, never a pass.
    return failure(500, "Sign-in is not configured on this server");
  }
  const user = identity.user;

  // A cookie rides along on any request the browser makes, so state changes must prove they came
  // from the CMS itself. Checked before any profile lookup or write.
  if (identity.transport === "cookie") {
    // Without the settings no token can be checked, so only reads go through.
    const settings = csrfSettings() ?? { publicOrigin: "", secret: "" };
    const unconfigured = !settings.secret && !["GET", "HEAD", "OPTIONS"].includes(req.method.toUpperCase());
    if (unconfigured || csrfProblem(req, identity, settings)) return { error: securityResponse("CSRF_FAILED") };
  }

  let profile: AdminUser | null = null;

  try {
    const store = usesDirectPostgres("admin") ? postgresAdminProfileStore() : supabaseAdminProfileStore(createServiceRoleClient());
    const resolved = await resolveAdminProfile(store, user);
    profile = resolved ? normalizeAdminUser(resolved) : null;
  } catch {
    profile = null;
  }

  if (!profile) {
    return {
      error: Response.json(
        { success: false, data: null, error: "Access denied", timestamp: new Date().toISOString() },
        { status: 403 },
      ),
    };
  }

  if (options.requireMaster && profile.role !== "master") {
    return {
      error: Response.json(
        { success: false, data: null, error: "Master access required", timestamp: new Date().toISOString() },
        { status: 403 },
      ),
    };
  }

  const requiredModules = options.requiredModule
    ? (Array.isArray(options.requiredModule) ? options.requiredModule : [options.requiredModule])
    : [];
  const requiredWriteModules = options.requiredWriteModule
    ? (Array.isArray(options.requiredWriteModule) ? options.requiredWriteModule : [options.requiredWriteModule])
    : [];

  if (requiredModules.length > 0 && !requiredModules.some((module) => hasModuleAccess(profile, module))) {
    return {
      error: Response.json(
        { success: false, data: null, error: "You do not have access to this module", timestamp: new Date().toISOString() },
        { status: 403 },
      ),
    };
  }

  if (requiredWriteModules.length > 0 && !requiredWriteModules.some((module) => hasModuleWriteAccess(profile, module))) {
    return {
      error: Response.json(
        { success: false, data: null, error: "You do not have write access to this module", timestamp: new Date().toISOString() },
        { status: 403 },
      ),
    };
  }

  // Owners need two registered authenticators and admins one (built-in auth; GoTrue reports null).
  if (!options.allowWithoutMfa && identity.authenticators !== null && identity.authenticators < requiredAuthenticators(profile.role)) {
    return { error: securityResponse("MFA_REQUIRED") };
  }

  if (options.stepUp && needsStepUp(identity)) return { error: securityResponse("STEP_UP_REQUIRED") };

  return { data: { user, profile, identity } };
}
