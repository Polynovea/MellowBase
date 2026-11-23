// First owner on the built-in auth: `npm run bootstrap:admin` with AUTH_PROVIDER=builtin, on plain
// PostgreSQL as the app role. The owner then signs in with that password and is an active master
// and workspace owner, who meets the MFA requirement before anything else.
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { closeDb } from "@/lib/db/index";
import { bootstrapBuiltinOwner } from "@/lib/auth/bootstrapOwner.mjs";
import { getBuiltinAuth, resetBuiltinAuthForTests } from "@/lib/auth/betterAuth/instance";
import { requireAdminRequest } from "@/lib/admin/serverAccess";

const run = promisify(execFile);
const BASE_URL = "https://cms.example.test";
const noPwned = async () => null;
let owner: pg.Client;
let app: pg.Client;
const savedEnv = { ...process.env };

async function workspace(): Promise<{ slug: string; ownerRoleId: string }> {
  const slug = `boot-${randomBytes(4).toString("hex")}`;
  const { rows: [ws] } = await owner.query("insert into workspaces (name, slug) values ($1, $1) returning id", [slug]);
  const { rows: [role] } = await owner.query("insert into roles (workspace_id, key, name, is_system) values ($1, 'owner', 'Owner', true) returning id", [ws.id]);
  await owner.query("insert into roles (workspace_id, key, name, is_system) values ($1, 'viewer', 'Viewer', true)", [ws.id]);
  return { slug, ownerRoleId: role.id };
}

const details = (slug: string) => {
  const suffix = randomBytes(4).toString("hex");
  return { email: `Boot-${suffix}@Example.test`, username: `boot-${suffix}`, displayName: "First Owner", workspaceSlug: slug };
};

/** Signs in through the app's own auth instance; returns the browser's Cookie header. */
async function signIn(email: string, password: string): Promise<{ status: number; cookie: string }> {
  const response = await getBuiltinAuth().handler(new Request(`${BASE_URL}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { origin: BASE_URL, "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  }));
  return { status: response.status, cookie: response.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ") };
}

beforeAll(async () => {
  owner = new pg.Client({ connectionString: process.env.POLYNOVEA_TEST_POSTGRES_OWNER_URL, ssl: false });
  app = new pg.Client({ connectionString: process.env.POLYNOVEA_TEST_POSTGRES_URL, ssl: false });
  await owner.connect();
  await app.connect();
  Object.assign(process.env, {
    AUTH_PROVIDER: "builtin",
    POLYNOVEA_AUTH_SECRET: randomBytes(32).toString("hex"),
    POLYNOVEA_PUBLIC_URL: BASE_URL,
    POLYNOVEA_HIBP_DISABLED: "true",
  });
  resetBuiltinAuthForTests();
});

afterAll(async () => {
  process.env = { ...savedEnv };
  resetBuiltinAuthForTests();
  await owner.end();
  await app.end();
  await closeDb();
});

describe("bootstrap the first owner on the built-in auth [postgres]", () => {
  it("creates the user with a confirmed address and an Argon2id password, then the owner rows, as the app role", async () => {
    const { slug, ownerRoleId } = await workspace();
    const input = details(slug);
    const password = `first owner ${randomBytes(8).toString("hex")}`;
    const result = await bootstrapBuiltinOwner(app, { ...input, password, pwnedLookup: noPwned });
    expect(result).toMatchObject({ createdUser: true, setPassword: true });

    const email = input.email.toLowerCase();
    const { rows: [user] } = await owner.query(
      `select u.id::text, u.email, u."emailVerified", a.password from polynovea_auth."user" u join polynovea_auth.account a on a."userId" = u.id where u.email = $1`,
      [email],
    );
    expect(user).toMatchObject({ id: result.authUserId, emailVerified: true });
    expect(user.password).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(JSON.stringify(user)).not.toContain(password);

    const { rows: roles } = await owner.query(
      `select a.role, a.is_active, m.status, r.role_id from admin_users a
         join workspace_members m on m.admin_user_id = a.id join member_roles r on r.workspace_member_id = m.id
        where a.auth_user_id = $1`,
      [result.authUserId],
    );
    expect(roles).toEqual([{ role: "master", is_active: true, status: "active", role_id: ownerRoleId }]);

    // Sign in with that password: the session belongs to an active master, who is sent to set up MFA.
    const { status, cookie } = await signIn(email, password);
    expect(status).toBe(200);
    const request = new Request(`${BASE_URL}/api/admin/me`, { headers: { cookie } });
    const profile = await requireAdminRequest(request, { allowWithoutMfa: true });
    expect(profile.data?.user.id).toBe(result.authUserId);
    expect(profile.data?.profile).toMatchObject({ role: "master", is_active: true, email });
    const gated = await requireAdminRequest(new Request(`${BASE_URL}/api/admin/users`, { headers: { cookie } }));
    expect(gated.error?.status).toBe(403);
    expect((await gated.error!.json()).code).toBe("MFA_REQUIRED");
  });

  it("refuses a password the rules reject, and leaves nothing behind", async () => {
    const { slug } = await workspace();
    const input = details(slug);
    await expect(bootstrapBuiltinOwner(app, { ...input, password: "short pw", pwnedLookup: noPwned })).rejects.toThrow(/at least 15/);
    await expect(bootstrapBuiltinOwner(app, { ...input, password: "password12345678", pwnedLookup: noPwned })).rejects.toThrow(/too common/);
    await expect(bootstrapBuiltinOwner(app, { ...input, password: null, pwnedLookup: noPwned })).rejects.toThrow(/No password/);
    const { rows: [counts] } = await owner.query(
      `select (select count(*)::int from polynovea_auth."user" where email = $1) as users, (select count(*)::int from admin_users where email = $1) as profiles`,
      [input.email.toLowerCase()],
    );
    expect(counts).toEqual({ users: 0, profiles: 0 });
  });

  it("running it again keeps the user's password and keeps them owner", async () => {
    const { slug } = await workspace();
    const input = details(slug);
    const password = `first owner ${randomBytes(8).toString("hex")}`;
    const first = await bootstrapBuiltinOwner(app, { ...input, password, pwnedLookup: noPwned });
    const second = await bootstrapBuiltinOwner(app, { ...input, password: `a different phrase ${randomBytes(4).toString("hex")}`, pwnedLookup: noPwned });
    expect(second).toMatchObject({ authUserId: first.authUserId, createdUser: false, setPassword: false, adminUserId: first.adminUserId });
    expect((await signIn(input.email.toLowerCase(), password)).status).toBe(200);
  });

  it("the script asks for the password without echo, and never prints it", async () => {
    const { slug } = await workspace();
    const input = details(slug);
    const password = `typed at the prompt ${randomBytes(6).toString("hex")}`;
    const child = execFile(process.execPath, ["scripts/bootstrap-admin.mjs", `--email=${input.email}`, `--username=${input.username}`, `--workspace=${slug}`], {
      env: { ...process.env, AUTH_PROVIDER: "builtin", POLYNOVEA_DATABASE_URL: process.env.POLYNOVEA_TEST_POSTGRES_URL, POLYNOVEA_BOOTSTRAP_ADMIN_PASSWORD: "" },
    });
    let output = "";
    child.stdout?.on("data", (chunk) => { output += chunk; });
    child.stderr?.on("data", (chunk) => { output += chunk; });
    child.stdin?.write(`${password}\n`);
    child.stdin?.write(`${password}\n`);
    child.stdin?.end();
    const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
    expect(output).toMatch(/Bootstrap complete/);
    expect(output).not.toContain(password);
    expect(code).toBe(0);
    expect((await signIn(input.email.toLowerCase(), password)).status).toBe(200);

    // Mismatched entries stop before anything is written.
    const other = details(slug);
    const mismatch = run(process.execPath, ["scripts/bootstrap-admin.mjs", `--email=${other.email}`, `--workspace=${slug}`], {
      env: { ...process.env, AUTH_PROVIDER: "builtin", POLYNOVEA_DATABASE_URL: process.env.POLYNOVEA_TEST_POSTGRES_URL, POLYNOVEA_BOOTSTRAP_ADMIN_PASSWORD: "" },
    });
    mismatch.child.stdin?.end("one long passphrase here\nanother long passphrase\n");
    await expect(mismatch).rejects.toMatchObject({ code: 1 });
    const { rows } = await owner.query(`select 1 from polynovea_auth."user" where email = $1`, [other.email.toLowerCase()]);
    expect(rows).toEqual([]);
  });
});
