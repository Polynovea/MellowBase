import { isIP } from "node:net";
import { postgresConnectionConfig } from "../infrastructure/postgresTls.mjs";
import { certificateAuthoritiesFor } from "./database/caBundles.mjs";

/**
 * Connection settings for a database configured by the setup wizard (config.enc). One
 * implementation for the app (lib/setup/mode.ts, lib/db/pool.ts) and plain-Node commands
 * (`polynovea-cms keys reencrypt`).
 *
 * TLS trusts exactly the root certificates the wizard verified the database with
 * (database.caBundleId, resolved by db-step's lib/setup/database/caBundles.mjs), never the system
 * store or DATABASE_CA_CERT, and verifies the endpoint name. A local database without TLS (the
 * bundled PostgreSQL on loopback, caBundleId null) connects as postgresTls.mjs decides. Throws when a
 * remote database has no bundle ID, or the bundle is unknown, missing or tampered: never weaker trust.
 *
 * The runtime deliberately connects by hostname, resolved by the system on each connection, not to
 * the IP the wizard pinned during its checks: managed databases (RDS, Azure) fail over by moving the
 * name to a new address. A name that later resolves somewhere hostile is bounded by the TLS settings:
 * only the pinned provider roots are trusted and the certificate must match `servername`, so a
 * different server cannot complete the handshake.
 *
 * @param {string} connectionString
 * @param {{ host: string, caBundleId: string | null }} database
 * @param {Record<string, string | undefined>} [env]
 */
export function tlsConnectionFor(connectionString, database, env = process.env) {
  const base = postgresConnectionConfig(connectionString, env);
  if (base.ssl === false) return base;
  if (!database.caBundleId) throw new Error("config.enc has no CA bundle for a remote database");
  const ca = certificateAuthoritiesFor(database.caBundleId);
  if (!ca) throw new Error(`config.enc names CA bundle ${database.caBundleId}, which this release does not ship`);
  const host = String(database.host).replace(/^\[|\]$/g, "");
  return {
    connectionString: base.connectionString,
    ssl: { rejectUnauthorized: true, ca, minVersion: "TLSv1.2", ...(isIP(host) ? {} : { servername: host }) },
  };
}
