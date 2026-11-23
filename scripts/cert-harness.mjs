/**
 * Real Certification Test Harness, on the built-in auth (no Supabase services).
 *
 * Provides:
 * - Real users in the built-in auth, created with the app's own password rules and Argon2id hasher
 *   (lib/auth/bootstrapOwner.mjs), then signed in over HTTP like the admin UI: session cookie, and
 *   the CSRF token on every request. Admin actors register an authenticator app first (as the app
 *   requires), and sign in with its code.
 * - Real Workspace scoping (x-workspace-id header & DB isolation)
 * - Real Cleanup with 0 leakage guarantees (deletes built-in users, admin_users, and the workspace)
 *
 * The app under test runs with AUTH_PROVIDER=builtin, POLYNOVEA_PUBLIC_URL equal to
 * CMS_CERT_BASE_URL, and POLYNOVEA_TRUSTED_PROXIES=127.0.0.1. Each actor signs in from its own
 * test address (X-Forwarded-For in 198.18.0.0/15, the benchmarking range), so a long run of scripts
 * does not trip the per-address sign-in limit.
 */
import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { createOTP } from "@better-auth/utils/otp";
import { base32 } from "@better-auth/utils/base32";
import { postgresConnectionConfig } from "../lib/infrastructure/postgresTls.mjs";
import { createBuiltinUser } from "../lib/auth/bootstrapOwner.mjs";
import { loadLocalEnv } from "./lib/loadLocalEnv.mjs";

// Settings come from the environment; .env.local, when present, fills any that are unset.
loadLocalEnv();

export const BASE_URL = (process.env.CMS_CERT_BASE_URL || "http://localhost:3000").replace(/\/$/, "");
const ORIGIN = new URL(BASE_URL).origin;
const ADMIN_ROLES = new Set(["master", "admin"]);

export async function createPgClient() {
  const connectionString =
    process.env.Database_URL ||
    process.env.DATABASE_URL ||
    process.env.database_url;
  if (!connectionString) throw new Error("Missing database connection string");
  const client = new pg.Client(postgresConnectionConfig(connectionString));
  await client.connect();
  return client;
}

export async function createDisposableWorkspace(client, prefix = "cert") {
  const slug = `${prefix}-${Date.now()}-${randomUUID().slice(0, 6)}`;
  const { rows } = await client.query(`
    insert into workspaces (name, slug)
    values ($1, $2)
    returning id, name, slug
  `, [`Disposable Workspace ${slug}`, slug]);
  return rows[0];
}

/** A cookie jar for one actor, speaking to /api/auth the way the browser does. */
function authSession(clientAddress) {
  const cookies = new Map();
  const cookieHeader = () => [...cookies].map(([name, value]) => `${name}=${value}`).join("; ");
  async function call(method, path, body) {
    const response = await fetch(`${BASE_URL}/api/auth${path}`, {
      method,
      headers: {
        origin: ORIGIN,
        "x-forwarded-for": clientAddress,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...(cookies.size ? { cookie: cookieHeader() } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    for (const setCookie of response.headers.getSetCookie()) {
      const [pair, ...attributes] = setCookie.split(";");
      const eq = pair.indexOf("=");
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (!value || attributes.some((attribute) => /max-age=0\b/i.test(attribute.trim()))) cookies.delete(name);
      else cookies.set(name, value);
    }
    const text = await response.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    if (!response.ok) throw new Error(`${method} /api/auth${path} failed with ${response.status}: ${text.slice(0, 300)}`);
    return json;
  }
  return { call, cookieHeader };
}

async function csrfToken(cookieHeader) {
  const response = await fetch(`${BASE_URL}/api/auth/csrf`, { headers: { cookie: cookieHeader } });
  const json = await response.json().catch(() => null);
  if (!response.ok || !json?.data?.token) throw new Error(`Could not get a CSRF token (${response.status}): ${JSON.stringify(json)}`);
  return json.data.token;
}

export async function createAuthenticatedActor(client, workspaceId, {
  role = "editor",
  permissions = [],
  emailPrefix = "cert-actor",
} = {}) {
  const email = `${emailPrefix}-${Date.now()}-${randomUUID().slice(0, 6)}@polynovea.local`;
  const password = `cert passphrase ${randomBytes(12).toString("base64url")}`;
  const validAdminRoles = ["master", "admin", "editor", "viewer"];
  const dbAdminRole = validAdminRoles.includes(role) ? role : "editor";
  if (dbAdminRole === "master") throw new Error("The harness does not create master actors (they need two authenticators); use admin with explicit permissions.");

  // 1. Real built-in auth user and its CMS profile, membership and permissions, in one transaction.
  let authUserId;
  let adminUserId;
  await client.query("begin");
  try {
    ({ authUserId } = await createBuiltinUser(client, { email, password, name: `Cert User ${email}`, pwnedLookup: async () => null }));

    const { rows: adminRows } = await client.query(`
      insert into admin_users (auth_user_id, username, email, display_name, role, is_active, surface_access, module_access, module_write_access)
      values ($1, $2, $3, $4, $5, true, array['cms'], array['*'], array['*'])
      returning id, email
    `, [authUserId, email, email, `Cert User ${email}`, dbAdminRole]);
    adminUserId = adminRows[0].id;

    const { rows: memberRows } = await client.query(`
      insert into workspace_members (workspace_id, admin_user_id, status)
      values ($1, $2, 'active')
      returning id
    `, [workspaceId, adminUserId]);
    const memberId = memberRows[0].id;

    if (permissions.length > 0) {
      const roleKey = `role_${Date.now().toString().slice(-6)}_${randomUUID().slice(0, 4)}`;
      const { rows: roleRows } = await client.query(`
        insert into roles (workspace_id, key, name, is_system)
        values ($1, $2, 'Cert Custom Role', false)
        returning id
      `, [workspaceId, roleKey]);
      const roleId = roleRows[0].id;
      for (const perm of permissions) {
        await client.query("insert into role_permissions (role_id, permission_key) values ($1, $2) on conflict do nothing", [roleId, perm]);
      }
      await client.query("insert into member_roles (workspace_member_id, role_id) values ($1, $2) on conflict do nothing", [memberId, roleId]);
    }
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  }

  // 2. Sign in over HTTP, as the admin UI does.
  const clientAddress = `198.18.${randomBytes(1)[0]}.${(randomBytes(1)[0] % 254) + 1}`;
  const session = authSession(clientAddress);
  try {
    await session.call("POST", "/sign-in/email", { email, password });
    if (ADMIN_ROLES.has(dbAdminRole)) {
      // Admins must have a second factor: register an authenticator app, then sign in again with its code.
      const enabled = await session.call("POST", "/two-factor/enable", { password });
      const secret = new URL(enabled.totpURI).searchParams.get("secret");
      const code = () => createOTP(base32.decode(secret)).totp();
      await session.call("POST", "/two-factor/verify-totp", { code: await code() });
      const again = await session.call("POST", "/sign-in/email", { email, password });
      if (!again?.twoFactorRedirect) throw new Error("Sign-in did not ask for the second factor");
      await session.call("POST", "/two-factor/verify-totp", { code: await code() });
    }
  } catch (error) {
    await client.query('delete from polynovea_auth."user" where id = $1', [authUserId]).catch(() => {});
    await client.query("delete from admin_users where id = $1", [adminUserId]).catch(() => {});
    throw error;
  }

  const cookie = session.cookieHeader();
  return {
    authUserId,
    adminUserId,
    email,
    headers: {
      cookie,
      origin: ORIGIN,
      "x-polynovea-csrf": await csrfToken(cookie),
      "x-workspace-id": workspaceId,
      "Content-Type": "application/json",
    },
  };
}

export async function teardownCertification({
  client,
  workspaceId,
  authUserIds = [],
  adminUserIds = [],
}) {
  const leaks = [];

  // 1. Release bundles and publication targets hold restrictive references.
  // Clear workspace-owned releases and targets first so those references cannot
  // block deletion of the disposable workspace.
  if (workspaceId) {
    try {
      await client.query(
        "delete from publication_jobs where target_id in (select id from publication_targets where workspace_id = $1) or workspace_id = $1",
        [workspaceId]
      );
      await client.query("delete from delivery_jobs where workspace_id = $1", [workspaceId]);
      await client.query("delete from website_connection_bindings where workspace_id = $1", [workspaceId]);
      await client.query("delete from publication_targets where workspace_id = $1", [workspaceId]);
      await client.query("delete from analytics_connectors where workspace_id = $1", [workspaceId]);
      await client.query("delete from workspace_connections where workspace_id = $1", [workspaceId]);
      await client.query("delete from releases where workspace_id = $1", [workspaceId]);
    } catch (err) {
      leaks.push({ type: "workspace_governance_references", id: workspaceId, error: err.message });
    }
  }

  // 2. Delete workspace (remaining workspace-owned data cascades normally).
  if (workspaceId) {
    try {
      await client.query("delete from workspaces where id = $1", [workspaceId]);
    } catch (err) {
      leaks.push({ type: "workspace", id: workspaceId, error: err.message });
    }
  }

  // 3. Delete admin_users records (now safe since foreign keys on workspace content are gone)
  for (const aid of adminUserIds) {
    try {
      await client.query("delete from admin_users where id = $1", [aid]);
    } catch (err) {
      leaks.push({ type: "admin_user", id: aid, error: err.message });
    }
  }

  // 4. Delete the built-in auth users (their sessions, passwords and second factors cascade).
  for (const uid of authUserIds) {
    try {
      await client.query('delete from polynovea_auth."user" where id = $1', [uid]);
    } catch (err) {
      leaks.push({ type: "auth_user", id: uid, error: err.message });
    }
  }

  if (leaks.length > 0) {
    console.error("\n[FATAL TEARDOWN LEAKAGE DETECTED]:", JSON.stringify(leaks, null, 2));
    throw new Error(`Certification teardown failed! ${leaks.length} fixtures leaked.`);
  }

  console.log("[TEARDOWN] All disposable auth users, admin users, and workspace destroyed. 0 fixtures leaked.");
}
