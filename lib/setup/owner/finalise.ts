import { Kysely, PostgresDialect } from "kysely";
import type pg from "pg";
import { symmetricEncrypt } from "better-auth/crypto";
import type { DB } from "@/lib/db/generated/database";
import { getSetupPool } from "@/lib/db/pool";
import { bootstrapBuiltinOwnerInTransaction } from "@/lib/auth/bootstrapOwner.mjs";
import { recordPlatformEvent } from "@/lib/platform/audit.postgres";
import { installConfig, markInstalled } from "@/lib/setup/mode";
import { endSetupSession, type SetupSession } from "@/lib/setup/setupSession";
import { EnrolmentError, publicAddress, readEnrolment, readyEnrolment, type ReadyEnrolment } from "@/lib/setup/owner/enrolment";
import { scheduleStarterContent } from "@/lib/setup/owner/starterJob";
import type { DatabaseMode } from "@/lib/setup/configStore";

/**
 * The end of the setup wizard: one transaction on the setup pool (app role) that writes everything
 * the owner step staged, then switches the CMS to running.
 *
 * 1. Serialise: a transaction-scoped advisory lock, then "is there an installation row?". A second
 *    browser finishing at the same moment waits here and then gets 409 "Setup was finished in
 *    another browser" before it writes anything.
 * 2. Rename the `polynovea` workspace seeded by migration 0007 (its name; the slug stays, the app
 *    finds its single workspace by it).
 * 3. The owner: bootstrapBuiltinOwnerInTransaction with the staged Argon2id hash. Refused if a
 *    sign-in already exists for the address: setup never takes over an existing account.
 * 4. The twoFactor row: TOTP secret and recovery codes encrypted with Better Auth's own
 *    symmetricEncrypt and the auth secret, as its two-factor plugin writes them (recovery codes stay
 *    encrypted); twoFactorEnabled set.
 * 5. The passkey row, as Better Auth's passkey plugin writes it.
 * 6. The installation row (with the owner, so it comes after the owner exists; the table's foreign
 *    key needs that, and the app role can never update the row afterwards). Its primary key is the
 *    final guard: a unique violation from any writer (the CLI included) is the same 409.
 * 7. The `setup.completed` platform event, in the same transaction, with no secrets in it.
 * 8. Commit, then markInstalled() and endSetupSession(). Starter content runs after that as a
 *    retryable job; its failure never touches the owner.
 *
 * Any error before the commit rolls everything back.
 */

type Env = Record<string, string | undefined>;
export type FinaliseStep = "lock" | "workspace" | "owner" | "twoFactor" | "passkey" | "installation" | "audit";

export const FINISHED_ELSEWHERE = "Setup was finished in another browser. Sign in with the owner account.";
export const SIGN_IN_PATH = "/admin";
/** Any fixed 64-bit number; only this code takes this lock. */
const FINALISE_LOCK_KEY = 7_315_220_260_001;

export class FinaliseError extends Error {
  readonly code: string;
  readonly status: 409 | 500;
  constructor(code: string, message: string, status: 409 | 500) {
    super(message);
    this.name = "FinaliseError";
    this.code = code;
    this.status = status;
  }
}

export interface FinaliseOptions {
  /** Defaults to getSetupPool(); tests pass their own app-role pool. */
  pool?: pg.Pool;
  env?: Env;
  /** Tests: called after each step inside the transaction (throw to simulate a failure there). */
  onStep?: (step: FinaliseStep) => void | Promise<void>;
}

export interface FinalisedOwner {
  authUserId: string;
  adminUserId: string;
  workspaceId: string;
  installId: string;
}

/** The auth secret the CMS signs and encrypts with: the environment, else config.enc's (set into the environment, as bootTasks does). */
export function resolveAuthSecret(env: Env = process.env): string {
  let secret = env.POLYNOVEA_AUTH_SECRET?.trim();
  if (!secret) {
    const config = installConfig(env);
    if (config?.authSecret) {
      env.POLYNOVEA_AUTH_SECRET = config.authSecret;
      secret = config.authSecret;
    }
  }
  if (!secret || secret.length < 32) throw new FinaliseError("AUTH_SECRET_MISSING", "The CMS has no auth secret yet. Finish the database step, or set POLYNOVEA_AUTH_SECRET.", 500);
  return secret;
}

function databaseMode(env: Env): DatabaseMode {
  try {
    return installConfig(env)?.databaseMode ?? "managed";
  } catch {
    return "managed";
  }
}

/** A Kysely bound to one checked-out client, so the audit helpers write in this transaction. */
function kyselyOn(client: pg.PoolClient): Kysely<DB> {
  const borrowed = { query: (...args: unknown[]) => (client.query as (...a: unknown[]) => unknown)(...args), release: () => {} };
  const single = { connect: async () => borrowed, end: async () => {} };
  return new Kysely<DB>({ dialect: new PostgresDialect({ pool: single as unknown as pg.Pool }) });
}

function isUniqueViolation(error: unknown, constraint?: string): boolean {
  const e = error as { code?: string; constraint?: string };
  return e?.code === "23505" && (!constraint || e.constraint === constraint);
}

/** The database part: one transaction, nothing left behind on any error. */
export async function commitOwnerSetup(ready: ReadyEnrolment, options: FinaliseOptions = {}): Promise<FinalisedOwner> {
  const env = options.env ?? process.env;
  const step = async (name: FinaliseStep) => options.onStep?.(name);
  const address = publicAddress(env);
  if (ready.passkey.rpID !== address.rpID) {
    throw new EnrolmentError("PASSKEY_ADDRESS", "The CMS address changed since you added your passkey. Add the passkey again.", 409);
  }
  const authSecret = resolveAuthSecret(env);
  const encryptedSecret = await symmetricEncrypt({ key: authSecret, data: ready.totpSecret });
  const encryptedCodes = await symmetricEncrypt({ key: authSecret, data: JSON.stringify(ready.recoveryCodes) });

  const client = await (options.pool ?? getSetupPool()).connect();
  let released = false;
  try {
    await client.query("begin");
    try {
      // 1. One finisher at a time; then the row decides.
      await client.query("select pg_advisory_xact_lock($1::bigint)", [FINALISE_LOCK_KEY]);
      const existing = await client.query("select 1 from public.installation where singleton");
      if (existing.rowCount) throw new FinaliseError("SETUP_FINISHED", FINISHED_ELSEWHERE, 409);
      await step("lock");

      // 2. The workspace migration 0007 seeded.
      const workspace = await client.query<{ id: string }>(
        "update public.workspaces set name = $2, updated_at = now() where slug = $1 returning id",
        [ready.organisation.workspaceSlug, ready.organisation.workspaceName],
      );
      if (!workspace.rowCount) throw new FinaliseError("WORKSPACE_MISSING", "The default workspace is missing. Run the database migrations, then finish setup again.", 500);
      await step("workspace");

      // 3. The owner, with the staged hash.
      const owner = await bootstrapBuiltinOwnerInTransaction(client, {
        email: ready.account.email,
        passwordHash: ready.account.passwordHash,
        username: ready.account.username,
        displayName: ready.account.displayName,
        workspaceSlug: ready.organisation.workspaceSlug,
      });
      if (!owner.createdUser) {
        throw new FinaliseError("ACCOUNT_EXISTS", "A sign-in already exists for this email address. Setup only creates a new owner; use a different address.", 409);
      }
      await step("owner");

      // 4. Authenticator app and recovery codes, as Better Auth's two-factor plugin stores them.
      await client.query(
        `insert into polynovea_auth."twoFactor" ("secret", "backupCodes", "userId", "verified", "failedVerificationCount") values ($1, $2, $3::uuid, true, 0)`,
        [encryptedSecret, encryptedCodes, owner.authUserId],
      );
      await client.query(`update polynovea_auth."user" set "twoFactorEnabled" = true, "updatedAt" = now() where id = $1::uuid`, [owner.authUserId]);
      await step("twoFactor");

      // 5. The passkey, as Better Auth's passkey plugin stores it.
      await client.query(
        `insert into polynovea_auth."passkey" ("name", "publicKey", "userId", "credentialID", "counter", "deviceType", "backedUp", "transports", "createdAt", "aaguid")
         values ($1, $2, $3::uuid, $4, $5, $6, $7, $8, now(), $9)`,
        ["Added during setup", ready.passkey.publicKey, owner.authUserId, ready.passkey.credentialID, ready.passkey.counter, ready.passkey.deviceType, ready.passkey.backedUp, ready.passkey.transports, ready.passkey.aaguid],
      );
      await step("passkey");

      // 6. The installation row.
      const mode = databaseMode(env);
      const { rows: [installation] } = await client.query<{ install_id: string }>(
        `insert into public.installation (organisation_name, owner_admin_user_id, database_mode, app_version) values ($1, $2::uuid, $3, $4) returning install_id::text`,
        [ready.organisation.organisationName, owner.adminUserId, mode, env.npm_package_version ?? null],
      );
      await step("installation");

      // 7. Audit, in this transaction. Labels only: no keys, codes, hashes or addresses.
      await recordPlatformEvent(kyselyOn(client), {
        workspaceId: owner.workspaceId,
        actorAdminUserId: owner.adminUserId,
        action: "setup.completed",
        entityType: "installation",
        entityId: installation.install_id,
        metadata: {
          databaseMode: mode,
          passkeyRoute: address.temporary ? "temporary" : "own-domain",
          secondFactors: ["totp", "passkey"],
          recoveryCodes: ready.recoveryCodes.length,
          starterContent: ready.organisation.starterContent,
        },
      });
      await step("audit");

      await client.query("commit");
      return { authUserId: owner.authUserId, adminUserId: owner.adminUserId, workspaceId: owner.workspaceId, installId: installation.install_id };
    } catch (error) {
      await client.query("rollback").catch(() => {});
      if (isUniqueViolation(error, "installation_pkey")) throw new FinaliseError("SETUP_FINISHED", FINISHED_ELSEWHERE, 409);
      if (isUniqueViolation(error, "passkey_credentialID_idx")) throw new FinaliseError("PASSKEY_EXISTS", "That passkey is already registered. Add a new passkey and finish again.", 409);
      throw error;
    }
  } catch (error) {
    // A broken connection must not go back to the pool in an unknown state.
    if (!(error instanceof FinaliseError) && !(error instanceof EnrolmentError)) {
      client.release(true);
      released = true;
    }
    throw error;
  } finally {
    if (!released) client.release();
  }
}

/**
 * The whole finish: checks every step is done, commits, switches the CMS to running, ends the setup
 * session and queues the starter content. Returns where the browser goes next.
 */
export async function finaliseOwnerSetup(session: SetupSession, options: FinaliseOptions = {}): Promise<FinalisedOwner & { next: string }> {
  const ready = readyEnrolment(readEnrolment(session));
  const result = await commitOwnerSetup(ready, options);
  markInstalled();
  endSetupSession();
  if (ready.organisation.starterContent) scheduleStarterContent({ workspaceId: result.workspaceId, actorAdminUserId: result.adminUserId });
  return { ...result, next: SIGN_IN_PATH };
}
