#!/usr/bin/env node
// Server-side commands run here, against the database; everything else is the Developer API client.
const [area, action] = process.argv.slice(2);

if (area === "auth") {
  if (action !== "migrate") {
    console.error("Usage: polynovea-cms auth migrate [--dry-run] [--from=URL] [--to=URL] [--user=UUID ...] [--json]");
    process.exit(1);
  }
  const { main } = await import("./auth/migrate-gotrue-users.mjs");
  try {
    process.exitCode = await main(process.argv.slice(4));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
} else if (area === "keys") {
  // Logic in lib/setup/reencrypt.ts, loaded with Node's type stripping (Node 24).
  const args = process.argv.slice(4);
  const batchArg = args.find((arg) => arg.startsWith("--batch-size="));
  const unknown = args.filter((arg) => arg !== "--dry-run" && !arg.startsWith("--batch-size="));
  if (action !== "reencrypt" || unknown.length) {
    console.error("Usage: polynovea-cms keys reencrypt [--dry-run] [--batch-size=200]");
    console.error("Rewrites the secrets stored in the database under the first key of CMS_MASTER_KEY (or master.key).");
    process.exit(1);
  }
  const pg = (await import("pg")).default;
  const { postgresConnectionConfig } = await import("../lib/infrastructure/postgresTls.mjs");
  const { readConfigSync, databaseUrlFromConfig } = await import("../lib/setup/configStore.mjs");
  const { reencryptSecrets, reencryptConfigFile, formatReencryptReport } = await import("../lib/setup/reencrypt.ts");
  let db;
  try {
    const config = readConfigSync();
    let connection;
    if (config) {
      // The wizard's database: TLS with exactly the CA bundle it verified (db-step's caBundles.mjs).
      const { tlsConnectionFor } = await import("../lib/setup/installConnection.mjs");
      connection = tlsConnectionFor(databaseUrlFromConfig(config, "app"), config.database);
    } else {
      const url = process.env.POLYNOVEA_DATABASE_URL?.trim() || process.env.DATABASE_URL?.trim();
      if (!url) throw new Error("No database: run this on the CMS server (config.enc), or set POLYNOVEA_DATABASE_URL");
      connection = postgresConnectionConfig(url);
    }
    db = new pg.Client({ ...connection, application_name: "polynovea-cms-keys" });
    await db.connect();
    const report = await reencryptSecrets(db, {
      dryRun: args.includes("--dry-run"),
      batchSize: batchArg ? Number(batchArg.slice("--batch-size=".length)) : undefined,
      log: (line) => console.log(line),
    });
    console.log(formatReencryptReport(report));
    console.log(`config.enc: ${await reencryptConfigFile(process.env, args.includes("--dry-run"))}`);
    process.exitCode = report.columns.some((column) => column.failed > 0) ? 2 : 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  } finally {
    await db?.end().catch(() => {});
  }
} else {
  await import("../packages/cms-cli/bin/polynovea-cms.mjs");
}
