import { parseManagedDatabaseInput, type ManagedDatabaseInput } from "./checks";
import { DatabaseSetupError, setupFailure } from "./errors";
import { runManagedDatabaseSetup, type ManagedFlowContext } from "./flow";
import type { ProvisionedDatabase } from "./provision";

/**
 * "Created for you": our cloud template made the database and put its admin login in a secret that
 * only this server's role can read. POLYNOVEA_DB_SECRET_REF names it:
 * - AWS: a Secrets Manager ARN, read with the instance role;
 * - Azure: a Key Vault secret URI, read with the VM's managed identity.
 *
 * The secret is read once, used for the same five checks, roles and migrations as a managed database,
 * and never stored, logged or sent to the browser. The template must store the connection fields in
 * the secret as JSON: {"username", "password", "host", "port", "dbname"} (the shape of an RDS secret
 * attached to its instance). `port` defaults to 5432 and `dbname` to "postgres".
 */

export type SecretRef =
  | { kind: "aws"; arn: string; region: string }
  | { kind: "azure"; uri: string; vaultUrl: string; name: string; version: string | null };

const AWS_ARN = /^arn:(aws|aws-cn|aws-us-gov):secretsmanager:([a-z]{2}(?:-[a-z]+)+-\d):(\d{12}):secret:([A-Za-z0-9/_+=.@-]{1,512})$/;
const AZURE_URI = /^https:\/\/([a-z0-9](?:[a-z0-9-]{1,22}[a-z0-9])?)\.(vault\.azure\.net|vault\.azure\.cn|vault\.usgovcloudapi\.net)\/secrets\/([A-Za-z0-9-]{1,127})(?:\/([0-9a-f]{32}))?\/?$/i;

/** Parses POLYNOVEA_DB_SECRET_REF (operator environment, never the browser). Null when it is not set or not recognised. */
export function parseSecretRef(value: string | undefined): SecretRef | null {
  const text = value?.trim();
  if (!text) return null;
  const aws = AWS_ARN.exec(text);
  if (aws) return { kind: "aws", arn: text, region: aws[2] };
  const azure = AZURE_URI.exec(text);
  if (azure) {
    const vaultUrl = `https://${azure[1].toLowerCase()}.${azure[2].toLowerCase()}`;
    return { kind: "azure", uri: text, vaultUrl, name: azure[3], version: azure[4]?.toLowerCase() ?? null };
  }
  return null;
}

/** Reads one secret's text through the server's own cloud identity. Built from the cloud SDKs by the route. */
export interface SecretReaders {
  aws?: (ref: Extract<SecretRef, { kind: "aws" }>) => Promise<string | undefined>;
  azure?: (ref: Extract<SecretRef, { kind: "azure" }>) => Promise<string | undefined>;
}

export const SECRET_UNREADABLE =
  "This server couldn't read the database secret your cloud template created. Check that the server's role (AWS) or managed identity (Azure) is allowed to read it, then try again.";
export const SECRET_MALFORMED =
  "The database secret your cloud template created doesn't include the database's address and login. Re-run the template, or choose \"Existing managed database\" and enter them.";

/** The connection fields from the secret's JSON. Errors never include the secret's text. */
export function parseDatabaseSecret(text: string): ManagedDatabaseInput {
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new DatabaseSetupError(SECRET_MALFORMED, "read-secret");
  }
  if (!value || typeof value !== "object" || typeof value.host !== "string" || typeof value.username !== "string" || typeof value.password !== "string") {
    throw new DatabaseSetupError(SECRET_MALFORMED, "read-secret");
  }
  try {
    return parseManagedDatabaseInput({
      hostname: value.host,
      port: value.port === undefined ? 5432 : value.port,
      database: typeof value.dbname === "string" && value.dbname ? value.dbname : "postgres",
      user: value.username,
      password: value.password,
    });
  } catch {
    throw new DatabaseSetupError(SECRET_MALFORMED, "read-secret");
  }
}

export async function readDatabaseSecret(ref: SecretRef, readers: SecretReaders): Promise<ManagedDatabaseInput> {
  let text: string | undefined;
  try {
    if (ref.kind === "aws") text = await readers.aws?.(ref);
    else text = await readers.azure?.(ref);
  } catch (error) {
    throw setupFailure("read-secret", SECRET_UNREADABLE, error);
  }
  if (typeof text !== "string" || !text) throw new DatabaseSetupError(SECRET_UNREADABLE, "read-secret");
  return parseDatabaseSecret(text);
}

export interface CreatedForYouContext extends Omit<ManagedFlowContext, "mode"> {
  secretRef: SecretRef;
  readers: SecretReaders;
}

export async function runCreatedForYouSetup(context: CreatedForYouContext): Promise<ProvisionedDatabase> {
  const label = "Reading the database secret your template created";
  context.emit({ type: "step", id: "read-secret", label, status: "running" });
  let input: ManagedDatabaseInput;
  try {
    input = await readDatabaseSecret(context.secretRef, context.readers);
  } catch (error) {
    const message = error instanceof DatabaseSetupError ? error.message : SECRET_UNREADABLE;
    context.emit({ type: "step", id: "read-secret", label, status: "failed", message });
    throw error;
  }
  context.emit({ type: "step", id: "read-secret", label, status: "passed" });
  return runManagedDatabaseSetup(input, { ...context, mode: "created" });
}
