import { CIPHERTEXT_PREFIX, ciphertextKid, decryptConfig, encryptConfig } from "../content/secureConfig.ts";
import { configPath, readConfigSync, writeConfig } from "./configStore.ts";
import { purposeKeys, requireKeyRing } from "./keyRing.ts";
import { existsSync, readFileSync } from "node:fs";

/**
 * `polynovea-cms keys reencrypt`: rewrites every secret the CMS keeps in its database under the
 * master key ring's first key. It moves values off the legacy CMS_CONFIG_ENCRYPTION_KEY and off
 * older ring keys after a rotation.
 *
 * - Batched, each batch in its own transaction with the rows locked, so a long run never holds the
 *   whole table and a crash loses at most the batch in flight.
 * - Safe to re-run: values already under the first key are skipped, and each update only applies if
 *   the value is still the one that was read.
 * - A value that cannot be decrypted is left as it is and counted, never dropped.
 * - Prints counts per column before and after.
 *
 * Imports are relative with extensions so scripts/polynovea-cms.mjs can load this file with Node's
 * type stripping.
 */

type Env = Record<string, string | undefined>;

export interface Queryable {
  query<R = Record<string, unknown>>(text: string, values?: unknown[]): Promise<{ rows: R[]; rowCount: number | null }>;
}

/** Every column that holds secureConfig ciphertext. Identifiers are constants, never input. */
export const ENCRYPTED_COLUMNS = [
  { table: "publication_targets", column: "config_json_encrypted" },
  { table: "webhook_subscriptions", column: "signing_secret_encrypted" },
  { table: "workspace_secret_refs", column: "encrypted_value" },
] as const;

export type ColumnCounts = { current: number; olderKey: number; legacy: number; notEncrypted: number };
export type ColumnReport = { table: string; column: string; before: ColumnCounts; after: ColumnCounts; rewritten: number; failed: number };
export type ReencryptReport = { primaryKid: string; dryRun: boolean; columns: ColumnReport[] };

// Legacy ciphertext is bare base64 of at least iv + tag + 1 byte; anything else (e.g. the
// "connection-ref:v1" marker some targets store) is not encrypted and is left alone.
const LEGACY_PATTERN = "^[A-Za-z0-9+/]{40,}={0,2}$";

function quote(identifier: string) {
  if (!/^[a-z_][a-z0-9_]*$/.test(identifier)) throw new Error(`Unexpected identifier ${identifier}`);
  return `"${identifier}"`;
}

async function counts(db: Queryable, table: string, column: string, primaryKid: string): Promise<ColumnCounts> {
  const col = quote(column);
  const { rows } = await db.query<{ current: string; older: string; legacy: string; other: string }>(
    `select
       count(*) filter (where starts_with(${col}, $1)) as current,
       count(*) filter (where starts_with(${col}, $2) and not starts_with(${col}, $1)) as older,
       count(*) filter (where not starts_with(${col}, $2) and ${col} ~ $3) as legacy,
       count(*) filter (where not starts_with(${col}, $2) and ${col} !~ $3) as other
     from public.${quote(table)} where ${col} is not null`,
    [`${CIPHERTEXT_PREFIX}${primaryKid}.`, CIPHERTEXT_PREFIX, LEGACY_PATTERN],
  );
  const row = rows[0];
  return { current: Number(row.current), olderKey: Number(row.older), legacy: Number(row.legacy), notEncrypted: Number(row.other) };
}

export async function reencryptSecrets(
  db: Queryable,
  options: { batchSize?: number; dryRun?: boolean; env?: Env; log?: (line: string) => void } = {},
): Promise<ReencryptReport> {
  const env = options.env ?? process.env;
  const batchSize = options.batchSize ?? 200;
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 5000) throw new Error("Batch size must be between 1 and 5000");
  const log = options.log ?? (() => {});
  const primaryKid = purposeKeys(requireKeyRing(env), "secure-config").primary.kid;
  const report: ReencryptReport = { primaryKid, dryRun: Boolean(options.dryRun), columns: [] };

  for (const { table, column } of ENCRYPTED_COLUMNS) {
    const before = await counts(db, table, column, primaryKid);
    let rewritten = 0;
    let failed = 0;
    if (!options.dryRun) {
      const col = quote(column);
      let lastId = "00000000-0000-0000-0000-000000000000";
      for (;;) {
        await db.query("begin");
        try {
          const { rows } = await db.query<{ id: string; value: string }>(
            `select id::text as id, ${col} as value from public.${quote(table)}
             where id > $1::uuid and ${col} is not null
               and not starts_with(${col}, $2)
               and (starts_with(${col}, $3) or ${col} ~ $4)
             order by id limit $5 for update`,
            [lastId, `${CIPHERTEXT_PREFIX}${primaryKid}.`, CIPHERTEXT_PREFIX, LEGACY_PATTERN, batchSize],
          );
          for (const row of rows) {
            let next: string;
            try {
              next = encryptConfig(decryptConfig<unknown>(row.value, env), env);
            } catch {
              failed += 1;
              log(`  ${table}.${column} ${row.id}: cannot be decrypted with the keys available (${ciphertextKid(row.value) ?? "legacy key"}); left unchanged`);
              continue;
            }
            const result = await db.query(`update public.${quote(table)} set ${col} = $1 where id = $2::uuid and ${col} = $3`, [next, row.id, row.value]);
            rewritten += result.rowCount ?? 0;
          }
          await db.query("commit");
          if (rows.length < batchSize) break;
          lastId = rows[rows.length - 1].id;
        } catch (error) {
          await db.query("rollback").catch(() => {});
          throw error;
        }
      }
    }
    const after = options.dryRun ? before : await counts(db, table, column, primaryKid);
    report.columns.push({ table, column, before, after, rewritten, failed });
  }
  return report;
}

/** Rewrites config.enc under the first master key when it uses an older one. Returns what happened. */
export async function reencryptConfigFile(env: Env = process.env, dryRun = false): Promise<"absent" | "current" | "rewritten" | "would-rewrite"> {
  const file = configPath(env);
  if (!existsSync(file)) return "absent";
  const primary = purposeKeys(requireKeyRing(env), "config").primary.kid;
  const kid = (JSON.parse(readFileSync(file, "utf8")) as { kid?: unknown }).kid;
  if (kid === primary) return "current";
  const config = readConfigSync(env);
  if (!config) return "absent";
  if (dryRun) return "would-rewrite";
  await writeConfig(config, env);
  return "rewritten";
}

export function formatReencryptReport(report: ReencryptReport): string {
  const line = (c: ColumnCounts) => `current ${c.current}, older key ${c.olderKey}, legacy ${c.legacy}, not encrypted ${c.notEncrypted}`;
  const out = [`Re-encrypting under master key ${report.primaryKid}${report.dryRun ? " (dry run: nothing written)" : ""}`];
  for (const c of report.columns) {
    out.push(`${c.table}.${c.column}`);
    out.push(`  before: ${line(c.before)}`);
    out.push(`  after:  ${line(c.after)}`);
    if (!report.dryRun) out.push(`  rewritten ${c.rewritten}, could not decrypt ${c.failed}`);
  }
  return out.join("\n");
}
