import type pg from "pg";
import { listMigrationFiles, MigrationLockError, runMigrations } from "@/scripts/run-migrations.mjs";

/**
 * Migrations for the setup wizard: the same runner as `npm run db:migrate`, over a client connected
 * as polynovea_owner, with one progress event per migration. The runner's in-process and advisory
 * locks mean a second wizard tab or a hand-run migration cannot interleave with this one.
 */

export type MigrationEvent = {
  type: "migration";
  filename: string;
  index: number;
  total: number;
  status: "running" | "applied" | "skipped" | "failed";
};

export interface MigrateOptions {
  emit: (event: MigrationEvent) => void;
  /** Repository root holding supabase/migrations (default: the working directory). */
  root?: string;
  files?: string[];
}

export { MigrationLockError };

export async function migrateAsOwner(ownerClient: pg.Client, options: MigrateOptions): Promise<{ applied: string[]; skipped: string[] }> {
  const files = options.files ?? listMigrationFiles(options.root);
  const result = await runMigrations(ownerClient, {
    files,
    waitForLockMs: 0,
    onProgress: (event: MigrationEvent) => options.emit({ type: "migration", filename: event.filename, index: event.index, total: event.total, status: event.status }),
  });
  return { applied: result.applied, skipped: result.skipped };
}
