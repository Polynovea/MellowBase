// One restore test of the bundled database's newest backup (lib/system/restoreTest.mjs), recorded in
// system_restore_tests and the audit log: `polynovea-cms system restore-test --reason <reason>`. The
// delivery worker starts it at low CPU and IO priority (nice -n 19, ionice -c 3).
// Returns 0: passed or skipped; 1: failed; 3: not applicable here (no bundled database); 4: another
// restore test is running (nothing was done).

import { promises as fs } from "node:fs";
import path from "node:path";
import pg from "pg";
import { runRestoreTest } from "../../lib/system/restoreTest.mjs";
import {
  dataRoot,
  directorySize,
  freeSpace,
  inServerImage,
  installDatabase,
  PG_BIN,
  pgbackrest,
  restoreCommand,
  runProgram,
  scrub,
  withClient,
} from "../../lib/system/serverHost.mjs";

/** @param {string[]} args */
export async function restoreTestCommand(args) {
  const reasonArg = args[args.indexOf("--reason") + 1];
  const reason = ["monthly", "first_backup", "manual"].includes(reasonArg)
    ? reasonArg
    : "manual";

  const database = installDatabase();
  if (!database || !database.local || !inServerImage()) {
    console.log(
      "[restore-test] Not applicable: this install has no bundled database.",
    );
    return 3;
  }

  const root = dataRoot();
  const live = new pg.Client({
    ...database.connection("app"),
    application_name: "polynovea-restore-test",
  });
  await live.connect();
  let exitCode = 1;
  try {
    const {
      rows: [begun],
    } = await live.query(
      "select public.polynovea_system_restore_test_begin($1) as id",
      [reason],
    );
    if (!begun?.id) {
      console.log("[restore-test] Another restore test is running.");
      exitCode = 4;
    } else {
      const host = {
        pgbackrest: async (args) => {
          const result = await pgbackrest(args);
          if (result.code !== 0)
            console.error(
              `[restore-test] pgbackrest ${args.at(-1)} exited ${result.code}: ${scrub(result.stderr || result.stdout)}`,
            );
          return result;
        },
        pgCtl: async (args) => {
          const result = await runProgram(
            path.posix.join(PG_BIN, "pg_ctl"),
            args,
            { timeoutMs: 20 * 60_000 },
          );
          if (result.code !== 0)
            console.error(
              `[restore-test] pg_ctl ${args[0]} exited ${result.code}: ${scrub(result.stderr)}`,
            );
          return result;
        },
        freeSpace,
        directorySize,
        list: (dir) => fs.readdir(dir),
        exists: (file) =>
          fs.access(file).then(
            () => true,
            () => false,
          ),
        makePrivateDir: (dir) =>
          fs.mkdir(dir, { recursive: true, mode: 0o700 }).then(() => undefined),
        remove: (dir) => fs.rm(dir, { recursive: true, force: true }),
        queryRestored: (socketDir, port, sql) =>
          withClient(
            {
              host: socketDir,
              port,
              user: "postgres",
              database: "polynovea",
              application_name: "polynovea-restore-test",
            },
            async (client) => (await client.query(sql)).rows,
          ),
        queryLive: async (sql) => (await live.query(sql)).rows,
      };
      const result = await runRestoreTest({
        host,
        id: begun.id,
        dataRoot: root,
        liveWalDir: path.posix.join(root, "postgresql", "pg_wal"),
        restoreCommand: restoreCommand(),
      });
      await live.query(
        "select public.polynovea_system_restore_test_finish($1, $2, $3, $4::jsonb, $5, $6)",
        [
          begun.id,
          result.status,
          result.backupLabel,
          JSON.stringify(result.checks),
          result.errorCode,
          result.errorMessage,
        ],
      );
      await live
        .query(
          `insert into public.platform_audit_events (workspace_id, action, entity_type, entity_id, metadata_json)
       select w.id, $1, 'system', $2, $3::jsonb from public.workspaces w order by w.created_at, w.id limit 1`,
          [
            `system.restore_test.${result.status}`,
            begun.id,
            JSON.stringify({
              reason,
              backupLabel: result.backupLabel,
              errorCode: result.errorCode,
            }),
          ],
        )
        .catch((error) =>
          console.error(
            `[restore-test] audit event not recorded: ${error.code ?? "error"}`,
          ),
        );
      console.log(
        `[restore-test] ${result.status}${result.errorCode ? ` (${result.errorCode}: ${result.errorMessage})` : ""}`,
      );
      exitCode = result.status === "failed" ? 1 : 0;
    }
  } finally {
    await live.end().catch(() => undefined);
  }
  return exitCode;
}
