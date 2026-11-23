/**
 * Moves users from Supabase GoTrue (`auth.users`) to the built-in auth (`polynovea_auth`), for
 * `polynovea-cms auth migrate`.
 *
 * Each user keeps the **same UUID**, so `admin_users.auth_user_id` still points at the right person
 * with no data change, plus their email (lower-cased), confirmed state, profile metadata, ban and
 * **bcrypt password hash**. The built-in auth verifies that hash and replaces it with Argon2id at the
 * user's next sign-in.
 *
 * Two-step sign-in comes across too. A user with a verified GoTrue TOTP factor keeps it, so their
 * authenticator app keeps working and a leaked password alone still cannot sign them in (dropping
 * the factor would let whoever holds the password enrol their own). The secret is stored the way the
 * built-in auth stores imported secrets (`base32:<secret>`, encrypted under POLYNOVEA_AUTH_SECRET).
 * GoTrue has no recovery codes, so the user starts with none and is asked to make them on
 * /admin/security. If GoTrue encrypted its MFA secrets, they cannot be read, and the command refuses
 * rather than drop anyone's second factor.
 *
 * Run it once, with the install in maintenance mode, just before switching AUTH_PROVIDER. Repeating
 * it is harmless for users who already exist (a user who has signed in since keeps their new hash),
 * but a later run would copy again any GoTrue user deleted from the built-in auth in the meantime.
 *
 * Before writing anything it refuses when:
 * - an `admin_users.auth_user_id` on the target would be left without a user;
 * - two GoTrue users share an address once lower-cased;
 * - an address already belongs to a different built-in user;
 * - a TOTP secret cannot be carried across, or POLYNOVEA_AUTH_SECRET is missing for one.
 * Everything is written in one transaction on the target.
 */
import pg from "pg";
import { symmetricEncrypt } from "better-auth/crypto";
import { postgresConnectionConfig } from "../../lib/infrastructure/postgresTls.mjs";

const SOURCE_SQL = `
  select u.id::text as id,
         lower(btrim(u.email)) as email,
         u.encrypted_password as password,
         u.email_confirmed_at is not null as "emailVerified",
         coalesce(u.raw_user_meta_data, '{}'::jsonb) as metadata,
         u.created_at as "createdAt",
         coalesce(u.updated_at, u.created_at) as "updatedAt",
         u.banned_until as "bannedUntil",
         (select f.secret from auth.mfa_factors f
           where f.user_id = u.id and f.status = 'verified' and f.factor_type = 'totp'
           order by f.created_at, f.id limit 1) as "totpSecret",
         (select count(*)::int from auth.mfa_factors f
           where f.user_id = u.id and f.status = 'verified' and f.factor_type = 'totp') as "totpFactors"
    from auth.users u
   where u.deleted_at is null
     and coalesce(u.is_anonymous, false) = false
     and u.email is not null and btrim(u.email) <> ''
   order by u.created_at, u.id`;

// bcrypt as GoTrue writes it; anything else (empty, or an SSO-only account) gets no password.
const BCRYPT = /^\$2[aby]\$\d\d\$[./A-Za-z0-9]{53}$/;
// GoTrue keeps TOTP secrets as plain base32 unless its database encryption is switched on.
const BASE32 = /^[A-Z2-7]{16,}=*$/i;

function displayName(user) {
  const meta = user.metadata && typeof user.metadata === "object" ? user.metadata : {};
  for (const key of ["display_name", "full_name", "name"]) {
    if (typeof meta[key] === "string" && meta[key].trim()) return meta[key].trim().slice(0, 200);
  }
  return user.email.split("@")[0];
}

async function counts(target) {
  const { rows: [row] } = await target.query(`
    select (select count(*)::int from polynovea_auth."user") as users,
           (select count(*)::int from polynovea_auth.account where "providerId" = 'credential') as passwords`);
  return row;
}

/**
 * @param {{ source: pg.ClientBase, target: pg.ClientBase, secret?: string | null, dryRun?: boolean, onlyUserIds?: string[] | null }} options
 *   `secret` is POLYNOVEA_AUTH_SECRET (the app must use the same value); it encrypts TOTP secrets.
 *   `onlyUserIds` limits the run (and its checks) to those users, for a staged rehearsal.
 */
export async function migrateGoTrueUsers({ source, target, secret = null, dryRun = false, onlyUserIds = null }) {
  const scope = onlyUserIds ? new Set(onlyUserIds) : null;
  const sourceUsers = (await source.query(SOURCE_SQL)).rows.filter((user) => !scope || scope.has(user.id));

  const problems = [];
  const byEmail = new Map();
  for (const user of sourceUsers) {
    if (byEmail.has(user.email)) problems.push(`two GoTrue users share the address ${user.email} (${byEmail.get(user.email)} and ${user.id})`);
    byEmail.set(user.email, user.id);
  }

  const withTotp = sourceUsers.filter((user) => user.totpSecret);
  for (const user of withTotp) {
    if (!BASE32.test(user.totpSecret)) {
      problems.push(`the authenticator-app secret of ${user.email} is encrypted by GoTrue and cannot be carried across; have the user remove that factor in GoTrue first, or turn off GoTrue's MFA secret encryption`);
    }
  }
  if (withTotp.length && (typeof secret !== "string" || secret.length < 32)) {
    problems.push(`${withTotp.length} user(s) have an authenticator app: set POLYNOVEA_AUTH_SECRET (the value the app will use, 32+ characters) to carry it across`);
  }

  const { rows: existing } = await target.query(`select id::text as id, email from polynovea_auth."user"`);
  const existingIds = new Set(existing.map((row) => row.id));
  for (const row of existing) {
    const sourceId = byEmail.get(row.email);
    if (sourceId && sourceId !== row.id) problems.push(`${row.email} already belongs to built-in user ${row.id}, not GoTrue user ${sourceId}`);
  }

  const sourceIds = new Set(sourceUsers.map((user) => user.id));
  const { rows: profiles } = await target.query(`select id::text as id, auth_user_id::text as "authUserId", email from admin_users where auth_user_id is not null`);
  const orphans = profiles.filter((profile) => (!scope || scope.has(profile.authUserId)) && !sourceIds.has(profile.authUserId) && !existingIds.has(profile.authUserId));
  for (const orphan of orphans) problems.push(`admin user ${orphan.id} (${orphan.email ?? "no email"}) points at identity ${orphan.authUserId}, which exists in neither GoTrue nor the built-in auth`);

  const before = await counts(target);
  const toCreate = sourceUsers.filter((user) => !existingIds.has(user.id));
  const summary = {
    dryRun,
    goTrueUsers: sourceUsers.length,
    before,
    after: before,
    created: 0,
    passwordsCopied: 0,
    withoutPassword: sourceUsers.filter((user) => !BCRYPT.test(user.password ?? "")).map((user) => user.email),
    totpCarried: 0,
    mustMakeRecoveryCodes: withTotp.filter((user) => !existingIds.has(user.id)).map((user) => user.email),
    extraTotpFactorsDropped: sourceUsers.filter((user) => user.totpFactors > 1).map((user) => user.email),
    problems,
  };
  if (problems.length) return { ...summary, ok: false };
  if (dryRun) return { ...summary, ok: true, created: toCreate.length };

  await target.query("begin");
  try {
    for (const user of sourceUsers) {
      const banned = user.bannedUntil && new Date(user.bannedUntil) > new Date();
      const inserted = await target.query(
        `insert into polynovea_auth."user" (id, name, email, "emailVerified", "createdAt", "updatedAt", metadata, banned, "banReason", "banExpires")
         values ($1::uuid, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10)
         on conflict (id) do nothing`,
        [user.id, displayName(user), user.email, user.emailVerified, user.createdAt, user.updatedAt, JSON.stringify(user.metadata),
          banned, banned ? "Banned in Supabase Auth" : null, banned ? user.bannedUntil : null],
      );
      summary.created += inserted.rowCount;
      if (BCRYPT.test(user.password ?? "")) {
        const account = await target.query(
          `insert into polynovea_auth.account ("accountId", "providerId", "userId", password, "createdAt", "updatedAt")
           values ($1::text, 'credential', $2::uuid, $3, $4, now())
           on conflict ("providerId", "accountId") do nothing`,
          [user.id, user.id, user.password, user.createdAt],
        );
        summary.passwordsCopied += account.rowCount;
      }
      // Only for a user created in this run: one who already exists keeps whatever they set up since.
      if (user.totpSecret && inserted.rowCount > 0) {
        await target.query(
          `insert into polynovea_auth."twoFactor" (secret, "backupCodes", "userId", verified) values ($1, $2, $3::uuid, true)`,
          [
            await symmetricEncrypt({ key: secret, data: `base32:${user.totpSecret.replace(/=+$/, "").toUpperCase()}` }),
            await symmetricEncrypt({ key: secret, data: JSON.stringify([]) }),
            user.id,
          ],
        );
        await target.query(`update polynovea_auth."user" set "twoFactorEnabled" = true where id = $1::uuid`, [user.id]);
        summary.totpCarried += 1;
      }
    }
    // Re-check inside the transaction, so a profile added meanwhile cannot be left behind.
    const { rows: [left] } = await target.query(
      `select count(*)::int as n from admin_users a
        where a.auth_user_id is not null ${scope ? "and a.auth_user_id::text = any($1)" : ""}
          and not exists (select 1 from polynovea_auth."user" u where u.id = a.auth_user_id)`,
      scope ? [[...scope]] : [],
    );
    if (left.n > 0) throw new Error(`${left.n} admin user(s) would be left without an identity`);
    await target.query("commit");
  } catch (error) {
    await target.query("rollback");
    throw error;
  }
  return { ...summary, ok: true, after: await counts(target) };
}

function parseArgs(argv) {
  const flags = { users: [] };
  for (const arg of argv) {
    if (arg === "--dry-run") flags.dryRun = true;
    else if (arg === "--json") flags.json = true;
    else if (arg === "--help" || arg === "-h") flags.help = true;
    else if (arg.startsWith("--from=")) flags.from = arg.slice(7);
    else if (arg.startsWith("--to=")) flags.to = arg.slice(5);
    else if (arg.startsWith("--user=")) flags.users.push(arg.slice(7));
    else throw new Error(`Unknown option ${arg}`);
  }
  return flags;
}

const USAGE = `polynovea-cms auth migrate [--dry-run] [--from=URL] [--to=URL] [--user=UUID ...] [--json]

Copies Supabase Auth (GoTrue) users into the built-in auth with the same IDs, emails, confirmed
state, password hashes and authenticator apps. Run it once, with the install in maintenance mode
and POLYNOVEA_AUTH_SECRET set to the value the app will use, then set AUTH_PROVIDER=builtin and
NEXT_PUBLIC_AUTH_PROVIDER=builtin. Everyone signs in once more; users with an authenticator app
then make recovery codes. Do not run it again after the switch: it would re-create users deleted
from the built-in auth since.

  --from   database holding auth.users (default: DATABASE_URL)
  --to     database holding polynovea_auth and admin_users (default: POLYNOVEA_AUTH_MIGRATION_TARGET_URL, then --from)
  --user   only this GoTrue user (repeat for more), for a staged rehearsal
  --dry-run  check and count, write nothing`;

export async function main(argv = process.argv.slice(2), env = process.env, log = console.log) {
  const flags = parseArgs(argv);
  if (flags.help) {
    log(USAGE);
    return 0;
  }
  const fromUrl = flags.from || env.DATABASE_URL;
  const toUrl = flags.to || env.POLYNOVEA_AUTH_MIGRATION_TARGET_URL || fromUrl;
  if (!fromUrl) throw new Error("Set DATABASE_URL or pass --from");
  const source = new pg.Client(postgresConnectionConfig(fromUrl, env));
  const target = new pg.Client(postgresConnectionConfig(toUrl, env));
  await source.connect();
  await target.connect();
  try {
    const result = await migrateGoTrueUsers({ source, target, secret: env.POLYNOVEA_AUTH_SECRET ?? null, dryRun: Boolean(flags.dryRun), onlyUserIds: flags.users.length ? flags.users : null });
    if (flags.json) {
      log(JSON.stringify(result, null, 2));
    } else {
      log(`GoTrue users: ${result.goTrueUsers}`);
      log(`Built-in users before: ${result.before.users} (${result.before.passwords} with a password)`);
      if (!result.ok) {
        log("Refused, nothing was written:");
        for (const problem of result.problems) log(`  - ${problem}`);
      } else if (result.dryRun) {
        log(`Dry run: would create ${result.created} user(s). Nothing was written.`);
      } else {
        log(`Created ${result.created} user(s), copied ${result.passwordsCopied} password hash(es).`);
        log(`Built-in users after: ${result.after.users} (${result.after.passwords} with a password)`);
      }
      if (result.withoutPassword.length) log(`No password to copy (they need an owner to set one): ${result.withoutPassword.join(", ")}`);
      if (result.totpCarried) log(`Kept the authenticator app of ${result.totpCarried} user(s).`);
      if (result.mustMakeRecoveryCodes.length) log(`Ask these users to make recovery codes on Sign-in & security: ${result.mustMakeRecoveryCodes.join(", ")}`);
      if (result.extraTotpFactorsDropped.length) log(`Had more than one authenticator app in GoTrue; only the oldest was kept: ${result.extraTotpFactorsDropped.join(", ")}`);
    }
    return result.ok ? 0 : 2;
  } finally {
    await source.end();
    await target.end();
  }
}
