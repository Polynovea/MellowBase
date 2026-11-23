// `polynovea-cms auth migrate` on fixture data: real GoTrue users (created through GoTrue, so with
// GoTrue's own bcrypt hashes) in the Supabase test database are moved into the built-in auth on the
// plain PostgreSQL test database, then sign in there with their old passwords.
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { createClient } from "@supabase/supabase-js";
import { closeDb, getDb } from "@/lib/db/index";
import { createPolynoveaAuth } from "@/lib/auth/betterAuth/server";
import { main, migrateGoTrueUsers } from "@/scripts/auth/migrate-gotrue-users.mjs";

const BASE_URL = "https://cms.example.test";
let source: pg.Client;
let target: pg.Client;
const gotrue = () => createClient(process.env.POLYNOVEA_TEST_SUPABASE_URL!, process.env.POLYNOVEA_TEST_SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const auth = () => createPolynoveaAuth({ db: getDb(), secret: "m".repeat(64), baseURL: BASE_URL, rateLimit: false, pwnedLookup: async () => null });

interface Fixture { id: string; email: string; password: string }

async function goTrueUser(options: { confirmed?: boolean; metadata?: Record<string, unknown>; password?: string } = {}): Promise<Fixture> {
  const email = `Mig-${randomBytes(5).toString("hex")}@Example.test`;
  const password = options.password ?? `gotrue ${randomBytes(9).toString("base64url")}`;
  const { data, error } = await gotrue().auth.admin.createUser({ email, password, email_confirm: options.confirmed ?? true, user_metadata: options.metadata });
  if (error || !data.user) throw error ?? new Error("no GoTrue user");
  return { id: data.user.id, email: email.toLowerCase(), password };
}

/** The CMS profile on the target that must keep pointing at the same person. */
async function profileFor(authUserId: string) {
  const suffix = randomBytes(4).toString("hex");
  await target.query("insert into admin_users (auth_user_id, username, email) values ($1, $2, $3)", [authUserId, `mig-${suffix}`, `mig-${suffix}@example.test`]);
}

async function signIn(email: string, password: string) {
  return auth().handler(new Request(`${BASE_URL}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { origin: BASE_URL, "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  }));
}

beforeAll(async () => {
  source = new pg.Client({ connectionString: process.env.POLYNOVEA_TEST_SUPABASE_DB_URL, ssl: false });
  target = new pg.Client({ connectionString: process.env.POLYNOVEA_TEST_POSTGRES_OWNER_URL, ssl: false });
  await source.connect();
  await target.connect();
});

afterAll(async () => {
  await source.end();
  await target.end();
  await closeDb();
});

describe("auth migrate: GoTrue to the built-in auth [supabase -> postgres]", () => {
  it("keeps the UUID, email, confirmed state, metadata and bcrypt hash; the old password then signs in and is rehashed", async () => {
    const confirmed = await goTrueUser({ metadata: { display_name: "Mira Grant" } });
    const unconfirmed = await goTrueUser({ confirmed: false });
    for (const user of [confirmed, unconfirmed]) await profileFor(user.id);
    const only = [confirmed.id, unconfirmed.id];

    const dry = await migrateGoTrueUsers({ source, target, dryRun: true, onlyUserIds: only });
    expect(dry).toMatchObject({ ok: true, dryRun: true, goTrueUsers: 2, created: 2, problems: [] });
    expect((await target.query(`select count(*)::int as n from polynovea_auth."user" where id = any($1)`, [only])).rows[0].n).toBe(0);

    const run = await migrateGoTrueUsers({ source, target, onlyUserIds: only });
    expect(run).toMatchObject({ ok: true, created: 2, passwordsCopied: 2 });
    expect(run.after.users - run.before.users).toBe(2);

    const { rows } = await target.query(
      `select u.id::text, u.email, u."emailVerified", u.name, u.metadata, a.password
         from polynovea_auth."user" u join polynovea_auth.account a on a."userId" = u.id and a."providerId" = 'credential'
        where u.id = any($1) order by u.email`,
      [only],
    );
    const byId = Object.fromEntries(rows.map((row) => [row.id, row]));
    expect(byId[confirmed.id]).toMatchObject({ email: confirmed.email, emailVerified: true, name: "Mira Grant", metadata: { display_name: "Mira Grant" } });
    expect(byId[unconfirmed.id]).toMatchObject({ email: unconfirmed.email, emailVerified: false });
    const { rows: [original] } = await source.query("select encrypted_password from auth.users where id = $1", [confirmed.id]);
    expect(byId[confirmed.id].password).toBe(original.encrypted_password);
    expect(byId[confirmed.id].password).toMatch(/^\$2[aby]\$/);

    // The same password works on the built-in auth, and the hash becomes Argon2id.
    expect((await signIn(confirmed.email, "not the old password at all")).status).toBe(401);
    expect((await signIn(confirmed.email.toUpperCase(), confirmed.password)).status).toBe(200);
    const { rows: [rehashed] } = await target.query(`select password from polynovea_auth.account where "userId" = $1`, [confirmed.id]);
    expect(rehashed.password).toMatch(/^\$argon2id\$/);

    // Idempotent: nothing new, and the rehashed password is not overwritten with the old bcrypt hash.
    const again = await migrateGoTrueUsers({ source, target, onlyUserIds: only });
    expect(again).toMatchObject({ ok: true, created: 0, passwordsCopied: 0 });
    const { rows: [still] } = await target.query(`select password from polynovea_auth.account where "userId" = $1`, [confirmed.id]);
    expect(still.password).toMatch(/^\$argon2id\$/);
  });

  it("refuses, writing nothing, when a CMS profile would be left without an identity", async () => {
    const user = await goTrueUser();
    await profileFor(user.id);
    const ghost = randomUUID();
    await profileFor(ghost);
    const result = await migrateGoTrueUsers({ source, target, onlyUserIds: [user.id, ghost] });
    expect(result.ok).toBe(false);
    expect(result.problems.join("\n")).toContain(ghost);
    expect((await target.query(`select count(*)::int as n from polynovea_auth."user" where id = $1`, [user.id])).rows[0].n).toBe(0);
  });

  it("refuses when the address already belongs to a different built-in user", async () => {
    const user = await goTrueUser();
    await target.query(`insert into polynovea_auth."user" (name, email, "emailVerified") values ('Someone else', $1, true)`, [user.email]);
    const result = await migrateGoTrueUsers({ source, target, onlyUserIds: [user.id] });
    expect(result.ok).toBe(false);
    expect(result.problems.join("\n")).toMatch(/already belongs/);
  });

  it("lists users who must re-enrol two-step sign-in; TOTP secrets are never copied", async () => {
    const user = await goTrueUser();
    await source.query(
      "insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at, secret) values ($1, $2, 'phone', 'totp', 'verified', now(), now(), 'JBSWY3DPEHPK3PXP')",
      [randomUUID(), user.id],
    );
    const result = await migrateGoTrueUsers({ source, target, onlyUserIds: [user.id] });
    expect(result.ok).toBe(true);
    expect(result.mustReEnrolMfa).toEqual([user.email]);
    const { rows } = await target.query(`select count(*)::int as n from polynovea_auth."twoFactor" where "userId" = $1`, [user.id]);
    expect(rows[0].n).toBe(0);
  });

  it("runs from the command line, with a dry run that exits 0 and an exit code of 2 when refused", async () => {
    const user = await goTrueUser();
    const lines: string[] = [];
    const env = { ...process.env, DATABASE_URL: process.env.POLYNOVEA_TEST_SUPABASE_DB_URL, POLYNOVEA_AUTH_MIGRATION_TARGET_URL: process.env.POLYNOVEA_TEST_POSTGRES_OWNER_URL };
    expect(await main(["--dry-run", `--user=${user.id}`], env, (line: string) => lines.push(line))).toBe(0);
    expect(lines.join("\n")).toMatch(/Dry run: would create 1 user/);
    const ghost = randomUUID();
    await profileFor(ghost);
    expect(await main([`--user=${ghost}`], env, () => undefined)).toBe(2);
  });
});
