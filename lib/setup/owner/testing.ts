/**
 * Tests only: walks the owner step through the real enrolment functions, with the soft WebAuthn
 * authenticator standing in for the browser's passkey and a computed TOTP code for the phone.
 */
import { randomBytes } from "node:crypto";
import type pg from "pg";
import { createOTP } from "@better-auth/utils/otp";
import { SoftAuthenticator } from "@/lib/auth/betterAuth/testing/softAuthenticator";
import { resetSetupSessionsForTests, startSetupSession, type SetupSession } from "@/lib/setup/setupSession";
import {
  confirmKeys,
  confirmRecoveryCode,
  confirmTotp,
  issueRecoveryCodes,
  passkeyRegistrationOptions,
  readEnrolment,
  readyEnrolment,
  stageAccount,
  stageOrganisation,
  startTotp,
  TOTP_DIGITS,
  TOTP_PERIOD,
  verifyPasskeyRegistration,
  type ReadyEnrolment,
} from "@/lib/setup/owner/enrolment";

type Env = Record<string, string | undefined>;

export const TEST_PUBLIC_URL = "https://cms.example.test";
export const noPwned = async () => null;

export interface EnrolledOwner {
  session: SetupSession;
  ready: ReadyEnrolment;
  email: string;
  password: string;
  totpSecret: string;
  totpCode: () => Promise<string>;
  recoveryCodes: string[];
  authenticator: SoftAuthenticator;
}

export async function enrolOwner(env: Env, overrides: { workspaceSlug?: string; email?: string } = {}): Promise<EnrolledOwner> {
  // A fresh session store: a takeover would carry the previous owner's progress over.
  resetSetupSessionsForTests();
  const { session } = startSetupSession("https");
  const email = overrides.email ?? `owner-${randomBytes(5).toString("hex")}@example.test`;
  const password = `setup owner phrase ${randomBytes(6).toString("hex")}`;
  await stageAccount(session, { email, displayName: "Setup Owner", password }, { pwnedLookup: noPwned });

  startTotp(session);
  const totpSecret = readEnrolment(session).totp!.secret;
  const totpCode = () => createOTP(totpSecret, { digits: TOTP_DIGITS, period: TOTP_PERIOD }).totp();
  await confirmTotp(session, await totpCode());

  const url = new URL(env.POLYNOVEA_PUBLIC_URL!);
  const authenticator = new SoftAuthenticator(url.hostname);
  const { options } = await passkeyRegistrationOptions(session, env);
  await verifyPasskeyRegistration(session, authenticator.register(options, url.origin), env);

  const { codes, confirmNumber } = issueRecoveryCodes(session);
  confirmRecoveryCode(session, codes[confirmNumber - 1]);

  stageOrganisation(session, { organisationName: "Example Organisation", workspaceName: "Example Workspace", starterContent: false });
  await confirmKeys(session, {}, env);

  const ready = readyEnrolment(readEnrolment(session));
  if (overrides.workspaceSlug) ready.organisation = { ...ready.organisation, workspaceSlug: overrides.workspaceSlug };
  return { session, ready, email, password, totpSecret, totpCode, recoveryCodes: codes, authenticator };
}

/** A workspace with the system roles bootstrap expects, so tests never touch the seeded one. */
export async function testWorkspace(owner: pg.Pool | pg.Client): Promise<string> {
  const slug = `setup-${randomBytes(4).toString("hex")}`;
  const { rows: [ws] } = await owner.query("insert into workspaces (name, slug) values ($1, $1) returning id", [slug]);
  await owner.query("insert into roles (workspace_id, key, name, is_system) values ($1, 'owner', 'Owner', true), ($1, 'viewer', 'Viewer', true)", [ws.id]);
  return slug;
}

/**
 * Tests that write the installation singleton take this session lock and clear the row when done, so
 * test files running in parallel never see each other's row.
 */
export const INSTALLATION_TEST_LOCK = 7_315_220_260_002;

export async function withInstallationLock<T>(owner: pg.Pool, fn: () => Promise<T>): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query("select pg_advisory_lock($1::bigint)", [INSTALLATION_TEST_LOCK]);
    try {
      return await fn();
    } finally {
      await client.query("delete from public.installation");
    }
  } finally {
    await client.query("select pg_advisory_unlock($1::bigint)", [INSTALLATION_TEST_LOCK]).catch(() => {});
    client.release();
  }
}
