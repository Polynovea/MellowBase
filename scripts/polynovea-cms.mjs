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
} else {
  await import("../packages/cms-cli/bin/polynovea-cms.mjs");
}
