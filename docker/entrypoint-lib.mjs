/**
 * Decisions the image's entrypoint makes at start, kept apart so they can be tested
 * (docker/entrypoint-lib.test.ts). Shipped next to entrypoint.mjs in /opt/polynovea/bin.
 */

/**
 * Whether to start the bundled PostgreSQL at container start.
 *
 * Only when the install's saved settings (config.enc) say it uses "On this server". The wizard writes
 * config.enc only after every step, backups included, has passed, so it doubles as the success marker.
 * A cluster left behind by a failed or abandoned "On this server" attempt (then a managed database,
 * or setup still open) is NOT started: it would run with archive_mode on and no pgBackRest stanza,
 * and WAL would pile up in pg_wal. The wizard starts the cluster itself if the owner tries again.
 *
 * @param {{ clusterExists: boolean, readConfig: () => ({ databaseMode?: string } | null) }} input
 * @returns {{ start: boolean, reason: string }}
 */
export function bundledDatabaseDecision({ clusterExists, readConfig }) {
  if (!clusterExists) return { start: false, reason: "no bundled database cluster" };
  let config;
  try {
    config = readConfig();
  } catch {
    // The CMS itself reports an unreadable config.enc as "unavailable"; do not guess here.
    return { start: false, reason: "config.enc could not be read; not starting the bundled database" };
  }
  if (!config) return { start: false, reason: "setup has not saved a database yet; leaving the bundled cluster stopped" };
  if (config.databaseMode !== "local") {
    return { start: false, reason: `this install uses a ${config.databaseMode} database; leaving the bundled cluster stopped` };
  }
  return { start: true, reason: "this install uses the bundled database" };
}
