import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { EnvironmentKind } from "@/lib/infrastructure/types";
import { guardedFetch, isBlockedAddress } from "@/lib/infrastructure/guardedNetwork";

// Validates a connection URL up front so configuration errors get a clear message. This check alone does
// not stop DNS rebinding; the actual request must go through safeFetch / guardedFetch (or an SDK given
// guardedS3RequestHandler / guardedFetchFor), which re-validates the addresses at connect time.
export async function assertSafeOutboundUrl(raw: string, environmentKind: EnvironmentKind, options: { allowHttpLocal?: boolean } = {}) {
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error("Connection URL is invalid"); }
  const localAllowed = environmentKind === "local" && options.allowHttpLocal === true;
  if (url.username || url.password) throw new Error("Credentials must not be embedded in connection URLs");
  if (url.protocol !== "https:" && !(localAllowed && url.protocol === "http:")) throw new Error(localAllowed ? "Connection URL must use HTTPS or local HTTP" : "Connection URL must use HTTPS");
  // Node URL implementations may retain brackets around IPv6 literals.
  const host=url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const explicitLocal=host==="localhost" || host.endsWith(".localhost") || host.endsWith(".local");
  if (explicitLocal && !localAllowed) throw new Error("Loopback/private destinations are allowed only for Local environments");
  if (explicitLocal) return url;
  if (isIP(host)) {
    if (isBlockedAddress(host) && !localAllowed) throw new Error("Private network destinations are not allowed for this environment");
    return url;
  }
  let addresses: Array<{ address: string }>;
  try { addresses = await lookup(host,{all:true,verbatim:true}); } catch { throw new Error("Connection hostname could not be resolved"); }
  if (!localAllowed && addresses.some((address) => isBlockedAddress(address.address))) throw new Error("Connection hostname resolves to a private network address");
  return url;
}

/** Whether connections for this environment may reach private addresses (Local environments only). */
export function allowsPrivateNetwork(environmentKind: EnvironmentKind) {
  return environmentKind === "local";
}

export async function safeFetch(raw: string, environmentKind: EnvironmentKind, init: RequestInit = {}, maxRedirects = 2): Promise<Response> {
  const allowPrivate = allowsPrivateNetwork(environmentKind);
  let current = await assertSafeOutboundUrl(raw, environmentKind, { allowHttpLocal: true });
  for (let hop=0; hop<=maxRedirects; hop++) {
    const response=await guardedFetch(current,{...init,redirect:"manual"},{ allowPrivate });
    if (![301,302,303,307,308].includes(response.status)) return response;
    const location=response.headers.get("location");
    if (!location) return response;
    if (hop===maxRedirects) throw new Error("Connection verification exceeded the redirect limit");
    current=await assertSafeOutboundUrl(new URL(location,current).toString(),environmentKind,{allowHttpLocal:true});
  }
  throw new Error("Connection verification failed");
}
