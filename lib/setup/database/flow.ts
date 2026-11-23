import type { DatabaseAllowlist } from "@/lib/infrastructure/guardedNetwork.mjs";
import { runDatabaseChecks, type CheckContext, type ManagedDatabaseInput } from "./checks";
import { provisionDatabase, type DatabaseMode, type ProvisionDeps, type ProvisionedDatabase } from "./provision";
import type { SetupEvent } from "./stream";

/**
 * "Existing managed database" and "Created for you", end to end: the five checks, roles, migrations,
 * the limits check, and only then the save. Nothing is saved if any step fails.
 */

export interface ManagedFlowContext {
  emit: (event: SetupEvent) => void;
  allowlist?: string | DatabaseAllowlist;
  /** gate-config's writeConfig, wrapped by the route (adds authSecret etc.). Called once, after full success. */
  saveConfig: (result: ProvisionedDatabase) => Promise<void>;
  mode?: Extract<DatabaseMode, "managed" | "created">;
  checks?: Omit<CheckContext, "emit" | "allowlist">;
  provision?: ProvisionDeps;
  /**
   * Secrets the response stream redacts from every event. The admin password is added here while
   * held and removed (with the reference in `input`) as soon as the admin login has signed in, or
   * the checks have failed.
   */
  held?: string[];
}

function drop(held: string[] | undefined, secret: string) {
  if (!held) return;
  for (let index = held.indexOf(secret); index !== -1; index = held.indexOf(secret)) held.splice(index, 1);
}

/**
 * `input.password` is cleared as soon as the admin login has signed in (the connected client no
 * longer holds it either), so for the rest of the run nothing in this request references it.
 */
export async function runManagedDatabaseSetup(input: ManagedDatabaseInput, context: ManagedFlowContext): Promise<ProvisionedDatabase> {
  let password = input.password;
  context.held?.push(password);
  let passed;
  try {
    passed = await runDatabaseChecks(input, { ...context.checks, emit: context.emit, allowlist: context.allowlist });
  } finally {
    input.password = "";
    drop(context.held, password);
    password = "";
  }
  const result = await provisionDatabase(
    { adminClient: passed.adminClient, endpoint: passed.endpoint, database: input.database, mode: context.mode ?? "managed", emit: context.emit },
    context.provision,
  );
  await context.saveConfig(result);
  context.emit({ type: "done", databaseMode: result.databaseMode });
  return result;
}
