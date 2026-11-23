import { createCipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decryptConfig, encryptConfig } from "@/lib/content/secureConfig";
import { resetKeyRingCache } from "@/lib/setup/keyRing";
import { formatReencryptReport, reencryptSecrets } from "@/lib/setup/reencrypt";

// `polynovea-cms keys reencrypt` against the test database, as the app role (what the command uses).
// Other test files write encrypted rows with their own random keys at the same time; this test only
// asserts on its own rows, and their rows show up as "could not decrypt", left unchanged.

const legacyKey = randomBytes(32).toString("base64");
const oldEntry = `old:${randomBytes(32).toString("base64")}`;
const newEntry = `new:${randomBytes(32).toString("base64")}`;
const configDir = mkdtempSync(path.join(os.tmpdir(), "polynovea-reencrypt-"));
const before = { CMS_MASTER_KEY: oldEntry, CMS_CONFIG_ENCRYPTION_KEY: legacyKey, POLYNOVEA_CONFIG_DIR: configDir };
const after = { CMS_MASTER_KEY: `${newEntry},${oldEntry}`, CMS_CONFIG_ENCRYPTION_KEY: legacyKey, POLYNOVEA_CONFIG_DIR: configDir };

function legacyEncrypt(value: unknown, key = legacyKey) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(key, "base64"), iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64");
}

async function connect(url: string | undefined) {
  if (!url) throw new Error("Test database URL missing; run node scripts/dev-db/setup.mjs");
  const client = new pg.Client({ connectionString: url, ssl: false });
  await client.connect();
  return client;
}

describe("keys reencrypt", () => {
  let owner: pg.Client;
  let app: pg.Client;
  let workspaceId: string;
  const targets: Record<string, { id: string; plain: unknown }> = {};
  let webhook: { id: string; plain: unknown };

  const value = async (table: "publication_targets" | "webhook_subscriptions", id: string) => {
    const column = table === "publication_targets" ? "config_json_encrypted" : "signing_secret_encrypted";
    const { rows } = await owner.query(`select ${column} as value from ${table} where id = $1`, [id]);
    return rows[0].value as string;
  };

  beforeAll(async () => {
    owner = await connect(process.env.POLYNOVEA_TEST_POSTGRES_OWNER_URL);
    app = await connect(process.env.POLYNOVEA_TEST_POSTGRES_URL);
    const suffix = randomUUID().slice(0, 8);
    workspaceId = (await owner.query("insert into workspaces (name, slug) values ($1, $2) returning id", [`Reencrypt ${suffix}`, `reencrypt-${suffix}`])).rows[0].id;
    resetKeyRingCache();
    const seeds: Record<string, { plain: unknown; stored: string }> = {
      legacy1: { plain: { url: "https://a.example.com", token: "t1" }, stored: "" },
      legacy2: { plain: { url: "https://b.example.com", token: "t2" }, stored: "" },
      legacy3: { plain: { url: "https://c.example.com", token: "t3" }, stored: "" },
      olderKey: { plain: { url: "https://d.example.com" }, stored: "" },
      marker: { plain: null, stored: "connection-ref:v1" },
      foreign: { plain: null, stored: legacyEncrypt({ url: "https://e.example.com" }, randomBytes(32).toString("base64")) },
    };
    for (const name of ["legacy1", "legacy2", "legacy3"]) seeds[name].stored = legacyEncrypt(seeds[name].plain);
    seeds.olderKey.stored = encryptConfig(seeds.olderKey.plain, before);
    for (const [name, seed] of Object.entries(seeds)) {
      const { rows } = await owner.query("insert into publication_targets (workspace_id, name, target_type, config_json_encrypted) values ($1, $2, 'webhook', $3) returning id", [workspaceId, name, seed.stored]);
      targets[name] = { id: rows[0].id, plain: seed.plain };
    }
    const secret = { secret: `whsec_${randomBytes(8).toString("hex")}` };
    const { rows } = await owner.query(
      "insert into webhook_subscriptions (workspace_id, name, endpoint_url, signing_secret_hash, signing_secret_encrypted) values ($1, 'hook', 'https://hooks.example.com', $2, $3) returning id",
      [workspaceId, createHash("sha256").update(secret.secret).digest("hex"), legacyEncrypt(secret)],
    );
    webhook = { id: rows[0].id, plain: secret };
  });

  afterAll(async () => {
    await owner?.query("delete from workspaces where id = $1", [workspaceId]).catch(() => {});
    await Promise.all([owner?.end(), app?.end()]);
  });

  it("a dry run counts without writing", async () => {
    resetKeyRingCache();
    const stored = await value("publication_targets", targets.legacy1.id);
    const report = await reencryptSecrets(app, { env: after, dryRun: true });
    expect(report.primaryKid).toBe("new");
    const pt = report.columns.find((column) => column.table === "publication_targets")!;
    expect(pt.before.legacy).toBeGreaterThanOrEqual(4);
    expect(pt.before.olderKey).toBeGreaterThanOrEqual(1);
    expect(pt.before.notEncrypted).toBeGreaterThanOrEqual(1);
    expect(await value("publication_targets", targets.legacy1.id)).toBe(stored);
    expect(formatReencryptReport(report)).toContain("dry run");
  });

  it("moves legacy and older-key values to the first key in small batches; markers and unreadable values stay", async () => {
    resetKeyRingCache();
    const foreignBefore = await value("publication_targets", targets.foreign.id);
    const report = await reencryptSecrets(app, { env: after, batchSize: 2 });
    for (const name of ["legacy1", "legacy2", "legacy3", "olderKey"]) {
      const stored = await value("publication_targets", targets[name].id);
      expect(stored.startsWith("pv2.new."), name).toBe(true);
      expect(decryptConfig(stored, after)).toEqual(targets[name].plain);
    }
    const hook = await value("webhook_subscriptions", webhook.id);
    expect(hook.startsWith("pv2.new.")).toBe(true);
    expect(decryptConfig(hook, after)).toEqual(webhook.plain);
    expect(await value("publication_targets", targets.marker.id)).toBe("connection-ref:v1");
    expect(await value("publication_targets", targets.foreign.id)).toBe(foreignBefore);
    const pt = report.columns.find((column) => column.table === "publication_targets")!;
    expect(pt.rewritten).toBeGreaterThanOrEqual(4);
    expect(pt.failed).toBeGreaterThanOrEqual(1);
    expect(pt.after.current).toBeGreaterThanOrEqual(pt.before.current + 4);
  });

  it("is safe to run again: values already under the first key are not touched", async () => {
    resetKeyRingCache();
    const stored = await Promise.all(["legacy1", "olderKey"].map((name) => value("publication_targets", targets[name].id)));
    await reencryptSecrets(app, { env: after });
    expect(await Promise.all(["legacy1", "olderKey"].map((name) => value("publication_targets", targets[name].id)))).toEqual(stored);
  });

  it("after re-encryption the legacy key and the old ring key are no longer needed for these rows", async () => {
    resetKeyRingCache();
    const onlyNew = { CMS_MASTER_KEY: newEntry, POLYNOVEA_CONFIG_DIR: configDir };
    for (const name of ["legacy1", "legacy2", "legacy3", "olderKey"]) {
      expect(decryptConfig(await value("publication_targets", targets[name].id), onlyNew)).toEqual(targets[name].plain);
    }
  });
});
