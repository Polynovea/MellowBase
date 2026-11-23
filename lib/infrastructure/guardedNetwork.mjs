// Outbound network guard that closes the DNS-rebinding window. Shared by the app (via guardedNetwork.ts)
// and the plain-Node delivery worker.
//
// Checking a hostname's addresses and then letting fetch/SDKs resolve it again is not enough: a hostile
// DNS server can answer with a public IP for the check and a private one for the connection. Here the
// address check runs inside the socket's own DNS lookup, so the connection is made to exactly the
// addresses that were validated. Use guardedFetch for HTTP, guardedS3RequestHandler for AWS SDK clients,
// and guardedFetchFor for SDKs that take a fetch implementation (supabase-js).
import { lookup as dnsLookup } from "node:dns";
import { Agent as HttpAgent } from "node:http";
import { Agent as HttpsAgent } from "node:https";
import { BlockList, isIP } from "node:net";
import { Agent, fetch as undiciFetch } from "undici";

// Loopback, private, link-local (cloud metadata), CGNAT, benchmarking, documentation, multicast,
// reserved, and the IPv6 equivalents including NAT64. Also the two cloud platform addresses that sit
// outside those ranges: Azure's wire server 168.63.129.16 (a public address) and AWS's IPv6 instance
// metadata endpoint fd00:ec2::254.
const IPV4_ALWAYS_BLOCKED = [["0.0.0.0", 8], ["127.0.0.0", 8], ["169.254.0.0", 16], ["192.0.0.0", 24], ["192.0.2.0", 24], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4], ["168.63.129.16", 32], ["100.100.100.200", 32]];
const IPV4_PRIVATE = [["10.0.0.0", 8], ["100.64.0.0", 10], ["172.16.0.0", 12], ["192.168.0.0", 16]];
const IPV6_ALWAYS_BLOCKED = [["::", 128], ["::1", 128], ["fe80::", 10], ["fec0::", 10], ["ff00::", 8], ["64:ff9b::", 96], ["64:ff9b:1::", 48], ["100::", 64], ["2001:db8::", 32], ["2001::", 32], ["fd00:ec2::254", 128]];
const IPV6_PRIVATE = [["fc00::", 7]];

function blockList(v4, v6) {
  const list = new BlockList();
  for (const [net, prefix] of v4) list.addSubnet(net, prefix, "ipv4");
  for (const [net, prefix] of v6) list.addSubnet(net, prefix, "ipv6");
  return list;
}
const blocked = blockList([...IPV4_ALWAYS_BLOCKED, ...IPV4_PRIVATE], [...IPV6_ALWAYS_BLOCKED, ...IPV6_PRIVATE]);
const alwaysBlocked = blockList(IPV4_ALWAYS_BLOCKED, IPV6_ALWAYS_BLOCKED);

/** The eight 16-bit groups of a valid IPv6 address (dotted IPv4 tail allowed). */
function ipv6Groups(address) {
  let text = address;
  const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (dotted) {
    const [a, b, c, d] = dotted.slice(1).map(Number);
    text = `${text.slice(0, dotted.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = text.split("::");
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length > 1 && halves[1] ? halves[1].split(":") : [];
  const fill = halves.length > 1 ? 8 - head.length - tail.length : 0;
  const groups = [...head, ...Array(Math.max(fill, 0)).fill("0"), ...tail].map((group) => Number.parseInt(group, 16));
  return groups.length === 8 && groups.every((group) => Number.isInteger(group) && group >= 0 && group <= 0xffff) ? groups : null;
}

/**
 * The IPv4 address an IPv6 address carries, for the forms that reach it: IPv4-mapped (::ffff:a.b.c.d),
 * IPv4-translated (::ffff:0:a.b.c.d), IPv4-compatible (::a.b.c.d) and 6to4 (2002:aabb:ccdd::), in
 * dotted or hex notation. Null for any other address.
 */
export function embeddedIPv4(address) {
  const groups = ipv6Groups(address);
  if (!groups) return null;
  const v4 = (high, low) => `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
  const zero = (from, to) => groups.slice(from, to).every((group) => group === 0);
  if (zero(0, 5) && groups[5] === 0xffff) return v4(groups[6], groups[7]);
  if (zero(0, 4) && groups[4] === 0xffff && groups[5] === 0) return v4(groups[6], groups[7]);
  if (zero(0, 6)) return v4(groups[6], groups[7]);
  if (groups[0] === 0x2002) return v4(groups[1], groups[2]);
  return null;
}

function normalizeAddress(address) {
  return String(address).toLowerCase().replace(/^\[|\]$/g, "");
}

function checkAddress(list, address) {
  const normalized = normalizeAddress(address);
  const family = isIP(normalized);
  if (family === 4) return list.check(normalized, "ipv4");
  if (family === 6) {
    const v4 = embeddedIPv4(normalized);
    if (v4 !== null) return list.check(v4, "ipv4");
    return list.check(normalized, "ipv6");
  }
  return true;
}

/** @param {string} address @returns {boolean} true for any address a non-local request must not reach */
export function isBlockedAddress(address) {
  return checkAddress(blocked, address);
}

/**
 * @param {string} address
 * @returns {boolean} true for addresses nothing may reach, not even a database the operator allowed:
 * loopback, link-local, 0.0.0.0/8, multicast, reserved, documentation, NAT64, cloud metadata and
 * platform addresses (in any IPv4-in-IPv6 form). Private ranges are not in this list.
 */
export function isAlwaysBlockedAddress(address) {
  return checkAddress(alwaysBlocked, address);
}

export class BlockedDestinationError extends Error {
  constructor(message = "Outbound destination resolves to a private or reserved network address") {
    super(message);
    this.name = "BlockedDestinationError";
    this.status = 403;
    this.code = "EBLOCKEDDESTINATION";
  }
}

const systemResolver = (hostname, callback) => dnsLookup(hostname, { all: true, verbatim: true }, callback);

/**
 * A `net.connect`-compatible lookup that refuses to hand out a blocked address. With `allowPrivate`
 * (Local environments only) every address is allowed.
 */
export function createGuardedLookup(options = {}) {
  const resolve = options.resolve ?? systemResolver;
  return (hostname, lookupOptions, callback) => {
    resolve(hostname, (error, addresses) => {
      if (error) return callback(error, []);
      if (!addresses.length) return callback(Object.assign(new Error(`No addresses for ${hostname}`), { code: "ENOTFOUND" }), []);
      if (!options.allowPrivate && addresses.some((entry) => isBlockedAddress(entry.address))) return callback(new BlockedDestinationError(), []);
      if (typeof lookupOptions === "object" && lookupOptions?.all) return callback(null, addresses);
      return callback(null, addresses[0].address, addresses[0].family);
    });
  };
}

function assertLiteralAllowed(url, allowPrivate) {
  if (allowPrivate) return;
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  // IP literals skip DNS, so the connect-time lookup never sees them; check them here.
  if ((isIP(host) && isBlockedAddress(host)) || host === "localhost" || host.endsWith(".localhost")) throw new BlockedDestinationError();
}

const dispatchers = new Map();
function dispatcherFor(allowPrivate) {
  if (!dispatchers.has(allowPrivate)) dispatchers.set(allowPrivate, new Agent({ connect: { lookup: createGuardedLookup({ allowPrivate }) } }));
  return dispatchers.get(allowPrivate);
}

/** fetch whose connections can only reach validated public addresses (unless allowPrivate). */
export async function guardedFetch(input, init = {}, options = {}) {
  const allowPrivate = options.allowPrivate === true;
  const url = new URL(String(input));
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new BlockedDestinationError("Only HTTP(S) destinations are allowed");
  assertLiteralAllowed(url, allowPrivate);
  return undiciFetch(url, { ...init, dispatcher: dispatcherFor(allowPrivate) });
}

/** A fetch implementation for SDKs that accept one (supabase-js `global.fetch`). */
export function guardedFetchFor(options = {}) {
  return (input, init) => {
    if (typeof input === "string" || input instanceof URL) return guardedFetch(input, init, options);
    return guardedFetch(input.url, { method: input.method, headers: input.headers, body: input.body, duplex: "half", ...init }, options);
  };
}

const agents = new Map();
function agentFor(kind, allowPrivate, make) {
  const key = `${kind}:${allowPrivate}`;
  if (!agents.has(key)) agents.set(key, make(createGuardedLookup({ allowPrivate })));
  return agents.get(key);
}

/** An https.Agent whose connections only reach validated addresses. */
export function guardedHttpsAgent(options = {}) {
  return agentFor("https", options.allowPrivate === true, (lookup) => new HttpsAgent({ keepAlive: true, lookup }));
}

/** `requestHandler` options for AWS SDK v3 clients (S3, R2, MinIO). */
export function guardedS3RequestHandler(options = {}) {
  const allowPrivate = options.allowPrivate === true;
  return {
    httpsAgent: guardedHttpsAgent({ allowPrivate }),
    httpAgent: agentFor("http", allowPrivate, (lookup) => new HttpAgent({ keepAlive: true, lookup })),
  };
}

// ---------------------------------------------------------------------------------------------------
// Database targets for the setup wizard's "existing managed database" step.
//
// A managed database legitimately lives on a private address, so private ranges cannot be refused
// outright. The rule: resolve the name once; refuse the whole target if any answer is always-blocked;
// allow private answers only for Amazon RDS and Azure Database for PostgreSQL endpoint names, or for
// a host or network the operator listed in POLYNOVEA_SETUP_DB_ALLOWLIST; then connect to exactly the
// address that was checked (the pinned address), so a second DNS answer can never be used.

const MANAGED_DATABASE_SUFFIXES = Object.freeze([".rds.amazonaws.com", ".postgres.database.azure.com"]);
const HOSTNAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const DNS_TIMEOUT_MS = 5_000;

export class DatabaseTargetError extends Error {
  /**
   * @param {"invalid-port" | "invalid-host" | "localhost" | "blocked-address" | "private-literal" | "private-not-allowed" | "not-found" | "dns-timeout"} reason
   * @param {string} message
   */
  constructor(reason, message) {
    super(message);
    this.name = "DatabaseTargetError";
    this.reason = reason;
    this.status = 422;
    this.code = "EDBTARGET";
  }
}

/** Lower-cases, strips IPv6 brackets and one trailing dot. */
export function normalizeDatabaseHostname(hostname) {
  return String(hostname ?? "").trim().toLowerCase().replace(/^\[(.*)\]$/, "$1").replace(/\.$/, "");
}

/** True for a hostname under an Amazon RDS or Azure Database for PostgreSQL endpoint domain. */
export function isManagedDatabaseHostname(hostname) {
  const host = normalizeDatabaseHostname(hostname);
  if (!HOSTNAME.test(host)) return false;
  // endsWith on a suffix that starts with "." gives the label boundary: "evilrds.amazonaws.com" and
  // "rds.amazonaws.com.evil.com" both fail, and the bare suffix itself has no label in front.
  return MANAGED_DATABASE_SUFFIXES.some((suffix) => host.endsWith(suffix) && host.length > suffix.length);
}

/**
 * Parses POLYNOVEA_SETUP_DB_ALLOWLIST: hostnames and CIDR networks separated by commas or spaces.
 * Throws naming the first entry it cannot read, so an operator typo fails closed.
 * @param {string | undefined} text
 */
export function parseDatabaseAllowlist(text) {
  const hostnames = new Set();
  const networks = new BlockList();
  const entries = [];
  for (const raw of String(text ?? "").split(/[\s,]+/)) {
    const entry = raw.trim();
    if (!entry) continue;
    const cidr = /^(.+)\/(\d{1,3})$/.exec(entry);
    if (cidr) {
      const address = normalizeAddress(cidr[1]);
      const family = isIP(address);
      const prefix = Number(cidr[2]);
      if (!family || prefix > (family === 4 ? 32 : 128)) throw new Error(`POLYNOVEA_SETUP_DB_ALLOWLIST has an entry that is not a valid network: ${entry}`);
      networks.addSubnet(address, prefix, family === 4 ? "ipv4" : "ipv6");
      entries.push(entry);
      continue;
    }
    const host = normalizeDatabaseHostname(entry);
    if (isIP(host)) {
      networks.addAddress(host, isIP(host) === 4 ? "ipv4" : "ipv6");
    } else if (HOSTNAME.test(host)) {
      hostnames.add(host);
    } else {
      throw new Error(`POLYNOVEA_SETUP_DB_ALLOWLIST has an entry that is not a hostname or network: ${entry}`);
    }
    entries.push(entry);
  }
  return Object.freeze({ hostnames, networks, entries: Object.freeze(entries) });
}

function inAllowedNetwork(allowlist, address) {
  const normalized = normalizeAddress(address);
  const v4 = isIP(normalized) === 6 ? embeddedIPv4(normalized) : null;
  if (v4 !== null) return allowlist.networks.check(v4, "ipv4");
  return allowlist.networks.check(normalized, isIP(normalized) === 4 ? "ipv4" : "ipv6");
}

function lookupAll(resolve, hostname) {
  return new Promise((done, fail) => {
    const timer = setTimeout(() => fail(new DatabaseTargetError("dns-timeout", "The database name did not resolve in time")), DNS_TIMEOUT_MS);
    resolve(hostname, (error, addresses) => {
      clearTimeout(timer);
      if (error) {
        fail(new DatabaseTargetError("not-found", "The database name does not resolve"));
        return;
      }
      done(addresses ?? []);
    });
  });
}

/**
 * Checks a database host and port typed into the setup wizard and pins the address to connect to.
 *
 * @param {string} hostname what the user typed (an endpoint name, or a public IP address)
 * @param {number} port
 * @param {{ allowlist?: string | ReturnType<typeof parseDatabaseAllowlist>, resolve?: (hostname: string, callback: (error: Error | null, addresses: { address: string, family: number }[]) => void) => void }} [options]
 *   `allowlist` comes from the operator's environment (POLYNOVEA_SETUP_DB_ALLOWLIST), never from the wizard.
 * @returns {Promise<{ hostname: string, address: string, family: 4 | 6, port: number, addresses: string[], allowedBy: "public" | "managed-database" | "allowlist" }>}
 */
export async function resolveDatabaseTarget(hostname, port, options = {}) {
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new DatabaseTargetError("invalid-port", "The port must be a whole number from 1 to 65535");
  }
  const host = normalizeDatabaseHostname(hostname);
  const allowlist = typeof options.allowlist === "object" && options.allowlist !== null
    ? options.allowlist
    : parseDatabaseAllowlist(options.allowlist);

  const literal = isIP(host);
  if (literal) {
    if (isAlwaysBlockedAddress(host)) throw new DatabaseTargetError("blocked-address", "That address can never be used for the database");
    if (isBlockedAddress(host)) throw new DatabaseTargetError("private-literal", "Private IP addresses are not accepted; enter the database's endpoint name");
    return { hostname: host, address: host, family: /** @type {4 | 6} */ (literal), port, addresses: [host], allowedBy: "public" };
  }
  if (host === "localhost" || host.endsWith(".localhost")) {
    throw new DatabaseTargetError("localhost", "localhost is this server itself");
  }
  if (!HOSTNAME.test(host)) throw new DatabaseTargetError("invalid-host", "That is not a valid database endpoint name");

  // One resolution. The connection goes to the address returned here, never to a fresh lookup.
  const answers = await lookupAll(options.resolve ?? systemResolver, host);
  const addresses = answers.map((entry) => normalizeAddress(entry.address)).filter((address) => isIP(address));
  if (addresses.length === 0 || addresses.length !== answers.length) {
    throw new DatabaseTargetError("not-found", "The database name does not resolve");
  }
  if (addresses.some((address) => isAlwaysBlockedAddress(address))) {
    throw new DatabaseTargetError("blocked-address", "The database name points to an address that can never be used");
  }

  const privateAddresses = addresses.filter((address) => isBlockedAddress(address));
  let allowedBy = "public";
  if (privateAddresses.length) {
    if (isManagedDatabaseHostname(host)) allowedBy = "managed-database";
    else if (allowlist.hostnames.has(host) || privateAddresses.every((address) => inAllowedNetwork(allowlist, address))) allowedBy = "allowlist";
    else throw new DatabaseTargetError("private-not-allowed", "The database name points to a private address that is not allowed");
  }
  const address = addresses[0];
  return { hostname: host, address, family: /** @type {4 | 6} */ (isIP(address)), port, addresses, allowedBy: /** @type {"public" | "managed-database" | "allowlist"} */ (allowedBy) };
}
