// The setup wizard's final transaction on plain PostgreSQL, as the app role: everything or nothing,
// and exactly one owner and one installation row however many browsers finish at once.
import { randomBytes } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { symmetricDecrypt } from "better-auth/crypto";
import { closeDb } from "@/lib/db/index";
import { currentMode, resetModeForTests } from "@/lib/setup/mode";
import { isActiveSetupSession, resetSetupSessionsForTests, setSetupState } from "@/lib/setup/setupSession";
import { readEnrolment } from "@/lib/setup/owner/enrolment";
import { commitOwnerSetup, FinaliseError, finaliseOwnerSetup, type FinaliseStep } from "@/lib/setup/owner/finalise";
import { enrolOwner, TEST_PUBLIC_URL, testWorkspace, withInstallationLock } from "@/lib/setup/owner/testing";

const STEPS: FinaliseStep[] = ["lock", "workspace", "owner", "twoFactor", "passkey", "installation", "audit"];
let owner: pg.Pool;
let app: pg.Pool;
let env: Record<string, string | undefined>;

beforeAll(() => {
  owner = new pg.Pool({ connectionString: process.env.POLYNOVEA_TEST_POSTGRES_OWNER_URL, ssl: false, max: 3 });
  app = new pg.Pool({ connectionString: process.env.POLYNOVEA_TEST_POSTGRES_URL, ssl: false, max: 4 });
  env = { POLYNOVEA_PUBLIC_URL: TEST_PUBLIC_URL, POLYNOVEA_AUTH_SECRET: randomBytes(32).toString("hex"), CMS_MASTER_KEY: `k1:${randomBytes(32).toString("base64")}` };
});

afterEach(() => {
  resetModeForTests();
  resetSetupSessionsForTests();
});

afterAll(async () => {
  await Promise.all([owner.end(), app.end()]);
  await closeDb();
});

async function rowsFor(email: string) {
  const { rows: [counts] } = await owner.query(
    `select (select count(*)::int from polynovea_auth."user" where email = $1) as users,
            (select count(*)::int from admin_users where email = $1) as profiles,
            (select count(*)::int from public.installation) as installations`,
    [email],
  );
  return counts;
}

describe("finishing setup [postgres]", () => {
  it("writes the owner, both second factors, the installation row and the audit event in one go", async () => {
    await withInstallationLock(owner, async () => {
      const slug = await testWorkspace(owner);
      const enrolled = await enrolOwner(env, { workspaceSlug: slug });
      const result = await commitOwnerSetup(enrolled.ready, { pool: app, env });

      const { rows: [installation] } = await owner.query("select install_id::text, organisation_name, owner_admin_user_id::text, database_mode from public.installation");
      expect(installation).toEqual({ install_id: result.installId, organisation_name: "Example Organisation", owner_admin_user_id: result.adminUserId, database_mode: "managed" });

      const { rows: [workspace] } = await owner.query("select name from workspaces where slug = $1", [slug]);
      expect(workspace.name).toBe("Example Workspace");

      const { rows: [user] } = await owner.query(`select u."twoFactorEnabled", u."emailVerified", a.password from polynovea_auth."user" u join polynovea_auth.account a on a."userId" = u.id where u.id = $1`, [result.authUserId]);
      expect(user).toMatchObject({ twoFactorEnabled: true, emailVerified: true, password: enrolled.ready.account.passwordHash });

      const { rows: [twoFactor] } = await owner.query(`select secret, "backupCodes", verified from polynovea_auth."twoFactor" where "userId" = $1`, [result.authUserId]);
      expect(twoFactor.verified).toBe(true);
      expect(twoFactor.secret).not.toContain(enrolled.totpSecret);
      expect(await symmetricDecrypt({ key: env.POLYNOVEA_AUTH_SECRET!, data: twoFactor.secret })).toBe(enrolled.totpSecret);
      for (const value of enrolled.recoveryCodes) expect(twoFactor.backupCodes).not.toContain(value);
      expect(JSON.parse(await symmetricDecrypt({ key: env.POLYNOVEA_AUTH_SECRET!, data: twoFactor.backupCodes }))).toEqual(enrolled.recoveryCodes);

      const { rows: passkeys } = await owner.query(`select "credentialID", "publicKey", counter, "deviceType" from polynovea_auth.passkey where "userId" = $1`, [result.authUserId]);
      expect(passkeys).toEqual([{ credentialID: enrolled.ready.passkey.credentialID, publicKey: enrolled.ready.passkey.publicKey, counter: 0, deviceType: enrolled.ready.passkey.deviceType }]);

      const { rows: events } = await owner.query("select actor_admin_user_id::text, entity_id::text, metadata_json from platform_audit_events where action = 'setup.completed' and workspace_id = $1", [result.workspaceId]);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ actor_admin_user_id: result.adminUserId, entity_id: result.installId });
      const logged = JSON.stringify(events[0].metadata_json);
      for (const secret of [enrolled.email, enrolled.totpSecret, enrolled.ready.account.passwordHash, ...enrolled.recoveryCodes, env.CMS_MASTER_KEY!]) expect(logged).not.toContain(secret);
    });
  });

  it("two browsers finishing at the same moment leave exactly one owner and one installation row", async () => {
    await withInstallationLock(owner, async () => {
      const slug = await testWorkspace(owner);
      const first = await enrolOwner(env, { workspaceSlug: slug });
      const second = await enrolOwner(env, { workspaceSlug: slug });
      const outcomes = await Promise.allSettled([commitOwnerSetup(first.ready, { pool: app, env }), commitOwnerSetup(second.ready, { pool: app, env })]);

      expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(1);
      const refused = outcomes.find((o): o is PromiseRejectedResult => o.status === "rejected")!.reason;
      expect(refused).toBeInstanceOf(FinaliseError);
      expect(refused).toMatchObject({ status: 409, code: "SETUP_FINISHED", message: "Setup was finished in another browser. Sign in with the owner account." });

      const a = await rowsFor(first.email);
      const b = await rowsFor(second.email);
      expect(a.users + b.users).toBe(1);
      expect(a.profiles + b.profiles).toBe(1);
      expect(a.installations).toBe(1);
    });
  });

  it("a later finish, after one has committed, is refused before it writes anything", async () => {
    await withInstallationLock(owner, async () => {
      const slug = await testWorkspace(owner);
      const first = await enrolOwner(env, { workspaceSlug: slug });
      const late = await enrolOwner(env, { workspaceSlug: slug });
      await commitOwnerSetup(first.ready, { pool: app, env });
      await expect(commitOwnerSetup(late.ready, { pool: app, env })).rejects.toMatchObject({ status: 409, code: "SETUP_FINISHED" });
      expect(await rowsFor(late.email)).toMatchObject({ users: 0, profiles: 0, installations: 1 });
    });
  });

  it.each(STEPS)("a failure after the %s step leaves no rows at all", async (failAt) => {
    await withInstallationLock(owner, async () => {
      const slug = await testWorkspace(owner);
      const enrolled = await enrolOwner(env, { workspaceSlug: slug });
      const auditBefore = (await owner.query("select count(*)::int as n from platform_audit_events where action = 'setup.completed'")).rows[0].n;
      await expect(commitOwnerSetup(enrolled.ready, {
        pool: app,
        env,
        onStep: (step) => {
          if (step === failAt) throw new Error(`injected failure after ${step}`);
        },
      })).rejects.toThrow(`injected failure after ${failAt}`);

      expect(await rowsFor(enrolled.email)).toEqual({ users: 0, profiles: 0, installations: 0 });
      const { rows: [counts] } = await owner.query(
        `select (select name from workspaces where slug = $1) as workspace,
                (select count(*)::int from polynovea_auth.passkey where "credentialID" = $2) as passkeys,
                (select count(*)::int from platform_audit_events where action = 'setup.completed') as audit`,
        [slug, enrolled.ready.passkey.credentialID],
      );
      expect(counts).toEqual({ workspace: slug, passkeys: 0, audit: auditBefore });
    });
  });

  it("never takes over a sign-in that already exists for the address", async () => {
    await withInstallationLock(owner, async () => {
      const slug = await testWorkspace(owner);
      const enrolled = await enrolOwner(env, { workspaceSlug: slug });
      await owner.query(`insert into polynovea_auth."user" (name, email, "emailVerified", "createdAt", "updatedAt") values ('Someone', $1, true, now(), now())`, [enrolled.email]);
      await expect(commitOwnerSetup(enrolled.ready, { pool: app, env })).rejects.toMatchObject({ status: 409, code: "ACCOUNT_EXISTS" });
      expect(await rowsFor(enrolled.email)).toEqual({ users: 1, profiles: 0, installations: 0 });
    });
  });

  it("a passkey made for another address is refused before anything is written", async () => {
    const slug = await testWorkspace(owner);
    const enrolled = await enrolOwner(env, { workspaceSlug: slug });
    await expect(commitOwnerSetup(enrolled.ready, { pool: app, env: { ...env, POLYNOVEA_PUBLIC_URL: "https://other.example.test" } })).rejects.toMatchObject({ code: "PASSKEY_ADDRESS" });
    expect((await rowsFor(enrolled.email)).users).toBe(0);
  });

  it("then switches the CMS to running and ends the setup session", async () => {
    await withInstallationLock(owner, async () => {
      const slug = await testWorkspace(owner);
      const enrolled = await enrolOwner(env, { workspaceSlug: slug });
      // The staged slug is the seeded workspace's; point this run at the test workspace instead.
      const state = readEnrolment(enrolled.session);
      setSetupState(enrolled.session, "owner", { ...state, organisation: { ...state.organisation!, workspaceSlug: slug } });

      const result = await finaliseOwnerSetup(enrolled.session, { pool: app, env });
      expect(result.next).toBe("/admin");
      expect(currentMode()).toBe("running");
      expect(isActiveSetupSession(enrolled.session)).toBe(false);
    });
  });
});
