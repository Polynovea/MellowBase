// Shared PostgreSQL TLS policy for the app, the delivery worker and every script.
//
// Rules:
// - Local databases (localhost, 127.0.0.1, ::1) with no sslmode connect without TLS.
// - `sslmode=disable` connects without TLS. It is an explicit opt-out, e.g. a private Docker network.
// - Everything else uses TLS with full certificate and hostname verification. libpq's weaker
//   modes (`prefer`, `require`, `verify-ca`) are all upgraded to verify-full.
// - Providers that sign with their own CA (Supabase, AWS RDS, ...) are trusted by adding that CA
//   through DATABASE_CA_CERT (PEM text, `\n` escapes allowed) or DATABASE_CA_CERT_FILE (a path).
//   NODE_EXTRA_CA_CERTS also works when neither is set.
// - SSL parameters inside the URL (sslrootcert, sslcert, ...) are ignored, so a connection
//   string supplied by a workspace user can never make the server read a local file.
import { readFileSync } from "node:fs";
import { isIP } from "node:net";
import { rootCertificates } from "node:tls";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
const URL_SSL_PARAMS = ["sslmode", "sslrootcert", "sslcert", "sslkey", "sslcrl", "sslpassword", "uselibpqcompat"];

function extraCertificateAuthority(env) {
  const inline = env.DATABASE_CA_CERT?.trim();
  if (inline) return inline.replace(/\\n/g, "\n");
  const file = env.DATABASE_CA_CERT_FILE?.trim();
  if (file) return readFileSync(file, "utf8");
  return undefined;
}

/**
 * Returns `{ connectionString, ssl }` to spread into a `pg` Client or Pool config.
 * @param {string} connectionString
 * @param {Record<string, string | undefined>} [env]
 * @returns {{ connectionString: string, ssl: false | { rejectUnauthorized: true, ca?: string[] } }}
 */
export function postgresConnectionConfig(connectionString, env = process.env) {
  const url = new URL(connectionString);
  const sslmode = url.searchParams.get("sslmode")?.toLowerCase() ?? null;
  for (const param of URL_SSL_PARAMS) url.searchParams.delete(param);
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");

  if (sslmode === "disable" || (sslmode === null && LOCAL_HOSTS.has(host))) {
    return { connectionString: url.toString(), ssl: false };
  }
  const ca = extraCertificateAuthority(env);
  return {
    connectionString: url.toString(),
    ssl: ca ? { rejectUnauthorized: true, ca: [...rootCertificates, ca] } : { rejectUnauthorized: true },
  };
}

/**
 * TLS settings for a connection made to a pinned IP address (the setup wizard's database step).
 * node-postgres only sets the TLS server name from a hostname, so with an IP it would check the
 * certificate against the IP. `servername` keeps verify-full: SNI and the hostname check both use the
 * real endpoint name. `ca` replaces the system roots entirely, so only the given roots are trusted.
 * @param {{ servername: string, ca: string[] }} options
 * @returns {{ rejectUnauthorized: true, servername: string, ca: string[], minVersion: "TLSv1.2" }}
 */
export function pinnedTlsOptions({ servername, ca }) {
  if (typeof servername !== "string" || !servername || isIP(servername.replace(/^\[|\]$/g, ""))) {
    throw new Error("pinnedTlsOptions needs the endpoint's hostname as servername");
  }
  if (!Array.isArray(ca) || ca.length === 0 || ca.some((pem) => typeof pem !== "string" || !pem.includes("-----BEGIN CERTIFICATE-----"))) {
    throw new Error("pinnedTlsOptions needs at least one PEM root certificate");
  }
  return { rejectUnauthorized: true, servername, ca: [...ca], minVersion: "TLSv1.2" };
}
