import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { parseDatabaseSecret, parseSecretRef, readDatabaseSecret, runCreatedForYouSetup, SECRET_MALFORMED, SECRET_UNREADABLE } from "./createdForYou";
import { DatabaseSetupError } from "./errors";
import type { SetupEvent } from "./stream";

const PASSWORD = "Cl0ud-Generated-Pa55word";
const ARN = "arn:aws:secretsmanager:eu-west-1:123456789012:secret:polynovea/db-AbCdEf";
const SECRET = JSON.stringify({ engine: "postgres", host: "mydb.abc.eu-west-1.rds.amazonaws.com", port: 5432, username: "polynovea_admin", password: PASSWORD, dbname: "polynovea" });

let logged: MockInstance;
beforeEach(() => { logged = vi.spyOn(console, "error").mockImplementation(() => {}); });
afterEach(() => logged.mockRestore());

describe("parseSecretRef", () => {
  it("reads an AWS Secrets Manager ARN", () => {
    expect(parseSecretRef(` ${ARN} `)).toEqual({ kind: "aws", arn: ARN, region: "eu-west-1" });
    expect(parseSecretRef("arn:aws-us-gov:secretsmanager:us-gov-west-1:123456789012:secret:x")).toMatchObject({ kind: "aws", region: "us-gov-west-1" });
  });

  it("reads an Azure Key Vault secret URI, with or without a version", () => {
    expect(parseSecretRef("https://polynovea-kv.vault.azure.net/secrets/db-admin")).toEqual({ kind: "azure", uri: "https://polynovea-kv.vault.azure.net/secrets/db-admin", vaultUrl: "https://polynovea-kv.vault.azure.net", name: "db-admin", version: null });
    expect(parseSecretRef("https://kv1.vault.azure.net/secrets/db/0123456789abcdef0123456789abcdef")).toMatchObject({ version: "0123456789abcdef0123456789abcdef" });
  });

  it.each([undefined, "", "arn:aws:s3:::bucket", "arn:aws:secretsmanager:eu-west-1:1234:secret:x", "http://kv.vault.azure.net/secrets/x", "https://kv.vault.azure.net.evil.com/secrets/x", "https://evil.com/secrets/x", "https://kv.vault.azure.net/keys/x"])(
    "ignores %j", (value) => expect(parseSecretRef(value)).toBeNull());
});

describe("parseDatabaseSecret", () => {
  it("takes the RDS secret shape, with defaults for port and database", () => {
    expect(parseDatabaseSecret(SECRET)).toEqual({ hostname: "mydb.abc.eu-west-1.rds.amazonaws.com", port: 5432, database: "polynovea", user: "polynovea_admin", password: PASSWORD });
    expect(parseDatabaseSecret(JSON.stringify({ host: "h.postgres.database.azure.com", username: "u", password: "p" }))).toMatchObject({ port: 5432, database: "postgres" });
  });

  it.each(["not json", JSON.stringify({ username: "u", password: PASSWORD }), JSON.stringify({ host: "h", username: "u", password: PASSWORD, dbname: "Bad-Name" })])(
    "refuses an unusable secret without repeating it", (text) => {
      const error = (() => { try { parseDatabaseSecret(text); } catch (e) { return e as Error; } return null; })();
      expect(error).toBeInstanceOf(DatabaseSetupError);
      expect(error?.message).toBe(SECRET_MALFORMED);
      expect(error?.message).not.toContain(PASSWORD);
    });
});

describe("readDatabaseSecret", () => {
  it("uses the reader for the secret's cloud", async () => {
    const aws = vi.fn(async () => SECRET);
    await expect(readDatabaseSecret(parseSecretRef(ARN)!, { aws })).resolves.toMatchObject({ user: "polynovea_admin" });
    expect(aws).toHaveBeenCalledWith({ kind: "aws", arn: ARN, region: "eu-west-1" });
  });

  it("turns an SDK failure into a plain fix and logs only the error's name and message", async () => {
    const error = await readDatabaseSecret(parseSecretRef(ARN)!, { aws: async () => { throw Object.assign(new Error("AccessDeniedException: not authorized"), { $metadata: {} }); } }).then(() => new Error("did not fail"), (e: Error) => e);
    expect(error.message).toMatch(new RegExp(`^${SECRET_UNREADABLE.replace(/[.()]/g, "\\$&")} \\(ref [0-9a-f]{8}\\)$`));
    expect(JSON.stringify(logged.mock.calls)).toContain("AccessDeniedException");
  });

  it("refuses when no reader is available for that cloud", async () => {
    await expect(readDatabaseSecret(parseSecretRef("https://kv.vault.azure.net/secrets/x")!, {})).rejects.toThrow(SECRET_UNREADABLE);
  });
});

describe("runCreatedForYouSetup", () => {
  it("reports the secret step, then runs the managed checks with the secret's login, never emitting it", async () => {
    const events: SetupEvent[] = [];
    const error = await runCreatedForYouSetup({
      secretRef: parseSecretRef(ARN)!,
      readers: { aws: async () => SECRET },
      emit: (event) => events.push(event),
      saveConfig: async () => {},
      // DNS fails, which is enough to prove the flow continued into the five checks.
      checks: { resolve: (_host, cb) => cb(Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" }), []) },
    }).then(() => new Error("did not fail"), (e: Error) => e);
    expect(error).toBeInstanceOf(DatabaseSetupError);
    expect(events.map((e) => `${e.type}:${"id" in e ? e.id : ""}:${"status" in e ? e.status : ""}`)).toEqual([
      "step:read-secret:running", "step:read-secret:passed", "check:dns:running", "check:dns:failed",
    ]);
    expect(JSON.stringify(events) + JSON.stringify(logged.mock.calls)).not.toContain(PASSWORD);
  });
});
