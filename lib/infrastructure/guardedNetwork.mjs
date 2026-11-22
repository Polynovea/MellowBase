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
// reserved, and the IPv6 equivalents including NAT64.
const blocked = new BlockList();
for (const [net, prefix] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4]]) blocked.addSubnet(net, prefix, "ipv4");
for (const [net, prefix] of [["::", 128], ["::1", 128], ["fc00::", 7], ["fe80::", 10], ["fec0::", 10], ["ff00::", 8], ["64:ff9b::", 96], ["64:ff9b:1::", 48], ["100::", 64], ["2001:db8::", 32]]) blocked.addSubnet(net, prefix, "ipv6");

/** @param {string} address @returns {boolean} true for any address a non-local request must not reach */
export function isBlockedAddress(address) {
  const normalized = address.toLowerCase().replace(/^\[|\]$/g, "");
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(normalized) ?? /^::(\d+\.\d+\.\d+\.\d+)$/.exec(normalized);
  if (mapped) return blocked.check(mapped[1], "ipv4");
  const family = isIP(normalized);
  if (family === 4) return blocked.check(normalized, "ipv4");
  if (family === 6) return blocked.check(normalized, "ipv6");
  return true;
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
