/**
 * The first owner of an install: a built-in auth user plus the CMS rows that make them the active
 * master admin and workspace owner. Used by `npm run bootstrap:admin` (AUTH_PROVIDER=builtin) and,
 * in phase 2, by the setup wizard. Plain JavaScript (with bootstrapOwner.d.mts) so both can call it.
 *
 * Everything runs in one transaction on the given client, so a failure never leaves a user without
 * a profile, or a profile without its membership and owner role.
 *
 * The password goes through the same rules and hasher as the app (15+ characters, since a new
 * owner has no second factor yet; never a known-breached password; Argon2id). The address is
 * marked confirmed. The owner then meets the MFA requirement at first sign-in and registers two
 * sign-in methods before using the CMS.
 */
import { hashPassword } from "./betterAuth/passwordHash.mjs";
import { assertAcceptablePassword } from "./passwordPolicy.mjs";

const MASTER_ACCESS = Object.freeze({ role: "master", is_active: true, surface_access: ["cms", "content"], module_access: ["*"], module_write_access: ["*"] });

/**
 * Makes `authUserId` the active master admin and owner of the workspace. Expects an open
 * transaction on `client` (the caller commits or rolls back).
 */
export async function grantOwnerRows(client, { authUserId, email, username, displayName, workspaceSlug }) {
  const existing = await client.query("select id from admin_users where email = $1 order by id limit 2 for update", [email]);
  if (existing.rows.length > 1) throw new Error(`More than one admin user has the email ${email}. Resolve the duplicate before bootstrapping.`);
  const access = [MASTER_ACCESS.role, MASTER_ACCESS.is_active, MASTER_ACCESS.surface_access, MASTER_ACCESS.module_access, MASTER_ACCESS.module_write_access];
  const adminUser = existing.rows.length
    ? (await client.query(
      "update admin_users set auth_user_id = $2, username = $3, display_name = $4, role = $5, is_active = $6, surface_access = $7, module_access = $8, module_write_access = $9, updated_at = now() where id = $1 returning id",
      [existing.rows[0].id, authUserId, username, displayName, ...access],
    )).rows[0]
    : (await client.query(
      "insert into admin_users (auth_user_id, username, email, display_name, role, is_active, surface_access, module_access, module_write_access, created_by) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'bootstrap:admin') returning id",
      [authUserId, username, email, displayName, ...access],
    )).rows[0];

  const workspace = (await client.query("select id from workspaces where slug = $1", [workspaceSlug])).rows[0];
  if (!workspace) throw new Error(`Workspace '${workspaceSlug}' does not exist. Apply migrations before bootstrapping the first admin.`);

  const member = (await client.query(
    "insert into workspace_members (workspace_id, admin_user_id, status, updated_at) values ($1, $2, 'active', now()) on conflict (workspace_id, admin_user_id) do update set status = 'active', updated_at = now() returning id",
    [workspace.id, adminUser.id],
  )).rows[0];

  const ownerRole = (await client.query("select id from roles where workspace_id = $1 and key = 'owner'", [workspace.id])).rows[0];
  if (!ownerRole) throw new Error("Default owner role is missing. Apply workspace migrations first.");

  await client.query("delete from member_roles where workspace_member_id = $1 and role_id in (select id from roles where workspace_id = $2 and is_system)", [member.id, workspace.id]);
  await client.query("insert into member_roles (workspace_member_id, role_id) values ($1, $2) on conflict (workspace_member_id, role_id) do nothing", [member.id, ownerRole.id]);
  return { adminUserId: adminUser.id, workspaceId: workspace.id, memberId: member.id };
}

/**
 * Creates a built-in auth user with a confirmed address and a password, inside the caller's open
 * transaction: the same rules and Argon2id hasher as the app, and the same rows the library writes.
 * For users who are not the owner (other roles' profiles are the caller's business).
 */
export async function createBuiltinUser(client, { email, password, name, hasMfa = false, pwnedLookup }) {
  const address = String(email ?? "").trim().toLowerCase();
  if (!address.includes("@")) throw new Error("A valid email address is required.");
  await assertAcceptablePassword({ password, hasMfa, email: address, lookup: pwnedLookup });
  const passwordHash = await hashPassword(password);
  const { rows: [user] } = await client.query(
    `insert into polynovea_auth."user" (name, email, "emailVerified", "createdAt", "updatedAt") values ($1, $2, true, now(), now()) returning id::text as id`,
    [name || address.split("@")[0], address],
  );
  await client.query(
    `insert into polynovea_auth.account ("accountId", "providerId", "userId", password, "createdAt", "updatedAt") values ($1::text, 'credential', $2::uuid, $3, now(), now())`,
    [user.id, user.id, passwordHash],
  );
  return { authUserId: user.id, email: address };
}

const ARGON2ID_PHC = /^\$argon2id\$v=19\$m=\d+,t=\d+,p=\d+\$[A-Za-z0-9+/]+\$[A-Za-z0-9+/]+$/;

/**
 * Creates (or reuses) the built-in auth user for `email` and makes them the owner, inside the
 * caller's open transaction (no begin/commit here; the caller commits or rolls back).
 *
 * - A new user needs `password`, which must pass the password rules and is hashed with Argon2id,
 *   or `passwordHash`, an Argon2id PHC string already made by betterAuth/passwordHash.mjs from a
 *   password that already passed the rules (the setup wizard checks and hashes it at once, so it
 *   never holds the plaintext). Pass one or the other, not both.
 * - An existing user keeps their password (it is never reset here); a password is then optional,
 *   and only used when the user has none yet.
 *
 * @param {import("pg").ClientBase} client a client with an open transaction (the app role is enough)
 */
export async function bootstrapBuiltinOwnerInTransaction(client, { email, password = null, passwordHash: stagedHash = null, username, displayName, workspaceSlug, pwnedLookup }) {
  const address = String(email ?? "").trim().toLowerCase();
  if (!address.includes("@")) throw new Error("A valid email address is required.");
  if (password && stagedHash) throw new Error("Pass a password or a password hash, not both.");
  if (stagedHash && !ARGON2ID_PHC.test(stagedHash)) throw new Error("The password hash must be an Argon2id hash from the app's own hasher.");

  const found = (await client.query(`select id::text as id from polynovea_auth."user" where email = $1 for update`, [address])).rows[0];
  const hasPassword = found
    ? (await client.query(`select 1 from polynovea_auth.account where "userId" = $1::uuid and "providerId" = 'credential' and password is not null`, [found.id])).rowCount > 0
    : false;

  let passwordHash = null;
  if (!hasPassword) {
    if (stagedHash) {
      passwordHash = stagedHash;
    } else {
      if (!password) throw new Error(`No password is set for ${address}. Pass one to create the sign-in.`);
      // Rules first, so a refused password never leaves anything behind.
      await assertAcceptablePassword({ password, hasMfa: false, email: address, lookup: pwnedLookup });
      passwordHash = await hashPassword(password);
    }
  }

  const userId = found
    ? (await client.query(
      `update polynovea_auth."user" set "emailVerified" = true, banned = false, "banReason" = null, "banExpires" = null, "updatedAt" = now() where id = $1::uuid returning id::text as id`,
      [found.id],
    )).rows[0].id
    : (await client.query(
      `insert into polynovea_auth."user" (name, email, "emailVerified", "createdAt", "updatedAt") values ($1, $2, true, now(), now()) returning id::text as id`,
      [displayName || address.split("@")[0], address],
    )).rows[0].id;

  if (passwordHash) {
    await client.query(
      `insert into polynovea_auth.account ("accountId", "providerId", "userId", password, "createdAt", "updatedAt")
       values ($1::text, 'credential', $2::uuid, $3, now(), now())
       on conflict ("providerId", "accountId") do update set password = excluded.password, "updatedAt" = now()`,
      [userId, userId, passwordHash],
    );
  }

  const granted = await grantOwnerRows(client, { authUserId: userId, email: address, username, displayName, workspaceSlug });
  return { authUserId: userId, createdUser: !found, setPassword: Boolean(passwordHash), ...granted };
}

/**
 * Creates (or reuses) the built-in auth user for `email` and makes them the owner, in a transaction
 * of its own (begin, bootstrapBuiltinOwnerInTransaction, commit; rollback on any error).
 *
 * @param {import("pg").ClientBase} client a connected client with no open transaction
 */
export async function bootstrapBuiltinOwner(client, { email, password = null, username, displayName, workspaceSlug, pwnedLookup }) {
  const address = String(email ?? "").trim().toLowerCase();
  if (!address.includes("@")) throw new Error("A valid email address is required.");

  await client.query("begin");
  try {
    const result = await bootstrapBuiltinOwnerInTransaction(client, { email: address, password, username, displayName, workspaceSlug, pwnedLookup });
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  }
}
