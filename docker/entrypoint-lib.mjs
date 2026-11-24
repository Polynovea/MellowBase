/**
 * Decisions the image's entrypoint makes at start, kept apart so they can be tested
 * (docker/entrypoint-lib.test.ts). Shipped next to entrypoint.mjs in /opt/polynovea/bin.
 */

/**
 * Why the CMS must not start with this sign-in setting, or null when it may. The image's setup wizard
 * creates the owner in the built-in auth's tables and the browser bundle is built with
 * NEXT_PUBLIC_AUTH_PROVIDER=builtin, so AUTH_PROVIDER must be builtin (the image sets it; an override
 * would half-work: pages expecting one sign-in, the server answering with another).
 *
 * @param {Record<string, string | undefined>} env
 * @returns {string | null}
 */
export function authProviderProblem(env) {
  const value = (env.AUTH_PROVIDER ?? "").trim().toLowerCase();
  if (value === "builtin") return null;
  return `AUTH_PROVIDER is set to "${String(env.AUTH_PROVIDER ?? "").slice(0, 40)}", but this image only runs the built-in sign-in (its setup wizard creates the owner there). Remove AUTH_PROVIDER from your settings (the image sets it to builtin), then start again. Supabase can still be the database; it cannot be the sign-in.`;
}

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
