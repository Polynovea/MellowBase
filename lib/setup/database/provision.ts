import { randomBytes } from "node:crypto";
import type pg from "pg";
import {
  APP_ROLE,
  appRoleProblems,
  bootstrapInstallRoles,
  hardenPublicSchema,
  installationState,
  rolesInUseElsewhere,
  OWNER_ROLE,
  tablesMissingAppPolicy,
} from "@/lib/db/roles.mjs";
import { openClient as defaultOpenClient, type DatabaseEndpoint, type DatabaseLogin } from "./connect";
import { DatabaseSetupError, setupFailure } from "./errors";
import { migrateAsOwner, MigrationLockError, type MigrationEvent } from "./migrate";

/**
 * After the checks pass: the admin login creates polynovea_owner and polynovea_app with fresh random
 * passwords (sent as SCRAM verifiers, so the plaintext never reaches the server), and is then closed.
 * Migrations run as polynovea_owner. Afterwards we prove polynovea_app cannot create anything and that
 * every row-level-security table has its policy. Only the owner and app passwords leave this module,
 * for config.enc; the admin password is never seen here at all (the client is already signed in).
 */

export type ProvisionStepId = "read-secret" | "inspect" | "roles" | "admin-released" | "owner-login" | "migrations" | "verify";
export type ProvisionEvent = { type: "step"; id: ProvisionStepId; label: string; status: "running" | "passed" | "failed"; message?: string };

const LABELS: Record<ProvisionStepId, string> = {
  "read-secret": "Reading the database secret your template created",
  inspect: "Checking the database is free to use",
  roles: "Creating the Polynovea database users",
  "admin-released": "Closing the admin login",
  "owner-login": "Signing in as the Polynovea owner user",
  migrations: "Creating the tables",
  verify: "Checking the app user's limits",
};

export type DatabaseMode = "local" | "managed" | "created";

/** What the database step saves (through gate-config's writeConfig) once everything has passed. */
export interface ProvisionedDatabase {
  databaseMode: DatabaseMode;
  database: { host: string; port: number; name: string; caBundleId: string | null };
  roles: { owner: { user: string; password: string }; app: { user: string; password: string } };
  /** pgBackRest repository encryption password ("On this server" only). */
  backupRepoPassword?: string | null;
}

export const ALREADY_INSTALLED =
  "This database already belongs to a Polynovea CMS install. To keep that install, connect this server to it through its own settings; to start again, use a new, empty database.";
export const FOREIGN_DATABASE =
  "This database already holds Polynovea tables that this installer did not create, or that it cannot inspect with this login. Use a new, empty database.";
export const ROLES_IN_USE =
  "Another database on this server already uses Polynovea's database users, probably for another Polynovea CMS install. Setting up here would change their passwords and lock that install out, so setup stopped. Use a separate database server for this install.";

/** 32 random bytes, base64url: 43 characters. */
export function generateRolePassword(): string {
  return randomBytes(32).toString("base64url");
}

export interface ProvisionDeps {
  openClient?: (endpoint: DatabaseEndpoint, database: string, login: DatabaseLogin, options?: { connectTimeoutMs?: number; statementTimeoutMs?: number }) => Promise<pg.Client>;
  migrate?: typeof migrateAsOwner;
  generatePassword?: () => string;
  /** Repository root for supabase/migrations. */
  root?: string;
}

export interface ProvisionInput {
  /** Signed in as the admin login (or the bundled server's local admin). Ended by this function. */
  adminClient: pg.Client;
  endpoint: DatabaseEndpoint;
  database: string;
  mode: DatabaseMode;
  emit: (event: ProvisionEvent | MigrationEvent) => void;
  /** Called the moment the admin login is closed, so the caller can drop anything it still holds. */
  onAdminReleased?: () => void;
}

export async function provisionDatabase(input: ProvisionInput, deps: ProvisionDeps = {}): Promise<ProvisionedDatabase> {
  const open = deps.openClient ?? defaultOpenClient;
  const migrate = deps.migrate ?? migrateAsOwner;
  const generate = deps.generatePassword ?? generateRolePassword;
  const secrets: string[] = [];
  const emit = input.emit;

  const step = async <T>(id: ProvisionStepId, run: () => Promise<T>, fix: string): Promise<T> => {
    emit({ type: "step", id, label: LABELS[id], status: "running" });
    try {
      const result = await run();
      emit({ type: "step", id, label: LABELS[id], status: "passed" });
      return result;
    } catch (error) {
      const failure = error instanceof DatabaseSetupError ? error : setupFailure(`provision ${id}`, fix, error, secrets);
      emit({ type: "step", id, label: LABELS[id], status: "failed", message: failure.message });
      throw failure;
    }
  };

  let admin: pg.Client | null = input.adminClient;
  const releaseAdmin = async () => {
    if (!admin) return;
    const client = admin;
    admin = null;
    await client.end().catch(() => {});
    input.onAdminReleased?.();
  };

  let owner: pg.Client | null = null;
  try {
    await step("inspect", async () => {
      const state = await installationState(input.adminClient);
      if (state === "installed") throw new DatabaseSetupError(ALREADY_INSTALLED, "provision inspect");
      if (state === "foreign") throw new DatabaseSetupError(FOREIGN_DATABASE, "provision inspect");
      // The two users are shared by every database on this server. Their passwords are only (re)set
      // when no other database relies on them; otherwise another install would lose its login.
      const elsewhere = await rolesInUseElsewhere(input.adminClient);
      if (elsewhere.length) {
        console.warn("[setup/database] Refused: %s", elsewhere.map((use) => `${use.role} is used by database ${use.database}`).join("; "));
        throw new DatabaseSetupError(ROLES_IN_USE, "provision inspect");
      }
      return state;
    }, "We couldn't inspect the database with this login. Check that the admin login owns the database, then try again.");

    const ownerPassword = generate();
    const appPassword = generate();
    secrets.push(ownerPassword, appPassword);

    await step("roles", () => bootstrapInstallRoles(input.adminClient, { database: input.database, ownerPassword, appPassword }),
      "We couldn't create the Polynovea database users with this login. Use the admin (master) login your cloud created with the database: it must own the database and be able to create users.");

    await step("admin-released", releaseAdmin, "Closing the admin login failed.");

    owner = await step("owner-login", () => open(input.endpoint, input.database, { user: OWNER_ROLE, password: ownerPassword }, { connectTimeoutMs: 10_000 }),
      "The new Polynovea owner user could not sign in. If the database limits which users may connect (for example pg_hba.conf), allow polynovea_owner and polynovea_app, then try again.");
    const ownerClient = owner;

    await step("migrations", async () => {
      await hardenPublicSchema(ownerClient);
      try {
        await migrate(ownerClient, { emit, root: deps.root });
      } catch (error) {
        if (error instanceof MigrationLockError) {
          throw new DatabaseSetupError("Another setup or upgrade is already preparing this database. Wait for it to finish, then try again.", "provision migrations");
        }
        throw error;
      }
    }, "Creating the tables failed part-way. Nothing is lost: run the database step again and it carries on from where it stopped.");

    await step("verify", async () => {
      const problems = [...(await appRoleProblems(ownerClient))];
      const missing = await tablesMissingAppPolicy(ownerClient);
      if (missing.length) problems.push(`table(s) without the ${APP_ROLE} policy: ${missing.slice(0, 20).join(", ")}${missing.length > 20 ? ", …" : ""}`);
      if (problems.length) {
        throw setupFailure("provision verify", "The app user ended up with more rights than it should have, so setup stopped. Use a new, empty database, or ask your database administrator to remove extra rights from polynovea_app.", new Error(problems.join("; ")), secrets);
      }
      // The app login itself must work, with the password we are about to save.
      const app = await open(input.endpoint, input.database, { user: APP_ROLE, password: appPassword }, { connectTimeoutMs: 10_000 });
      try {
        await app.query("select 1");
      } finally {
        await app.end().catch(() => {});
      }
    }, "Checking the app user failed. Run the database step again.");

    return {
      databaseMode: input.mode,
      database: {
        host: input.endpoint.kind === "remote" ? input.endpoint.hostname : "127.0.0.1",
        port: input.endpoint.port,
        name: input.database,
        caBundleId: input.endpoint.kind === "remote" ? input.endpoint.caBundleId : null,
      },
      roles: { owner: { user: OWNER_ROLE, password: ownerPassword }, app: { user: APP_ROLE, password: appPassword } },
    };
  } finally {
    await releaseAdmin();
    if (owner) await (owner as pg.Client).end().catch(() => {});
  }
}
