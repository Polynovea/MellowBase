import { createServiceRoleClient } from "@/lib/admin/serviceRole";
import { logPlatformEvent } from "@/lib/platform/audit";
import { getActiveExtensionPrivileges } from "@/lib/developer/extensionGovernanceService";
import { lookup as dnsLookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

export type HostLookup = (hostname: string) => Promise<Array<{ address: string; family: number }>>;

// Every address range an extension must never reach: loopback, private, link-local
// (cloud metadata), carrier-grade NAT, multicast, reserved and the IPv6 equivalents.
const blockedAddresses = new BlockList();
for (const [net, prefix] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["224.0.0.0", 4], ["240.0.0.0", 4]] as const) blockedAddresses.addSubnet(net, prefix, "ipv4");
for (const [net, prefix] of [["::", 128], ["::1", 128], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8], ["64:ff9b::", 96], ["2001:db8::", 32]] as const) blockedAddresses.addSubnet(net, prefix, "ipv6");

function blockedAddress(address: string) {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped) return blockedAddresses.check(mapped[1], "ipv4");
  const family = isIP(address);
  if (family === 4) return blockedAddresses.check(address, "ipv4");
  if (family === 6) return blockedAddresses.check(address, "ipv6");
  return true;
}

// Resolve the host and refuse if ANY address it resolves to is internal, so a public
// name pointing at a private IP cannot be used to reach internal services.
async function assertPublicHost(hostname: string, lookup: HostLookup) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!host || host === "localhost" || host.endsWith(".localhost")) return false;
  if (isIP(host)) return !blockedAddress(host);
  let addresses: Array<{ address: string }>;
  try { addresses = await lookup(host); } catch { return false; }
  return addresses.length > 0 && addresses.every((entry) => !blockedAddress(entry.address));
}

const defaultLookup: HostLookup = (hostname) => dnsLookup(hostname, { all: true, verbatim: true });

async function active(workspaceId: string, installationId: string) {
  const installation: any = await getActiveExtensionPrivileges(workspaceId, installationId);
  const manifest = installation.extension_manifests?.manifest_json;
  if (!manifest) throw Object.assign(new Error("Extension manifest is unavailable"), { status: 409 });
  return { installation, manifest, extensionKey: String(installation.extension_manifests.extension_key) };
}

export async function authorizeExtensionRoute(params: { workspaceId: string; installationId: string; method: string; path: string }) {
  const state = await active(params.workspaceId, params.installationId);
  let decoded: string;
  try { decoded = decodeURIComponent(params.path); } catch { throw Object.assign(new Error("Extension route encoding is invalid"), { status: 400 }); }
  const expectedPrefix = `/extensions/${state.extensionKey}`;
  if (!decoded.startsWith(expectedPrefix) || (decoded.length > expectedPrefix.length && decoded[expectedPrefix.length] !== "/") || decoded.includes("..") || decoded.includes("//")) throw Object.assign(new Error("Extension route escapes its namespace"), { status: 403 });
  const route = (state.manifest.routes ?? []).find((item: any) => item.path === decoded && item.method === params.method.toUpperCase());
  if (!route) throw Object.assign(new Error("Extension route is not declared"), { status: 403 });
  if (route.permission && !state.installation.granted_permissions.includes(route.permission)) throw Object.assign(new Error("Extension route permission is not granted"), { status: 403 });
  return { extensionKey: state.extensionKey, route, grantedPermissions: state.installation.granted_permissions };
}

export async function extensionFetch(params: { workspaceId: string; installationId: string; actorId: string; url: string; method: string; body?: string; lookup?: HostLookup }) {
  const state = await active(params.workspaceId, params.installationId);
  let target: URL; try { target = new URL(params.url); } catch { throw Object.assign(new Error("Extension URL is invalid"), { status: 400 }); }
  if (target.username || target.password) throw Object.assign(new Error("Extension URL is not permitted"), { status: 403 });
  if (target.protocol !== "https:") throw Object.assign(new Error("External extension network requests require HTTPS"), { status: 403 });
  const requirement = (state.manifest.networkRequirements ?? []).find((item: any) => item.origin === target.origin);
  if (!requirement || !state.installation.granted_network_json.includes(requirement.origin) || !requirement.methods.includes(params.method.toUpperCase())) throw Object.assign(new Error("Extension network capability is not granted"), { status: 403 });
  // Rebuild the request URL from the granted origin, never from caller input.
  const grantedOrigin = new URL(String(requirement.origin));
  if (!(await assertPublicHost(grantedOrigin.hostname, params.lookup ?? defaultLookup))) throw Object.assign(new Error("Extension URL is not permitted"), { status: 403 });
  const origin = grantedOrigin.origin;
  const response = await fetch(new URL(`${target.pathname}${target.search}`, grantedOrigin), { method: params.method, body: params.body, redirect: "manual" });
  if (response.status >= 300 && response.status < 400) throw Object.assign(new Error("Extension redirects are blocked; declare and request the final exact origin"), { status: 409 });
  await logPlatformEvent({ workspaceId: params.workspaceId, actorAdminUserId: params.actorId, action: "extension.network.invoked", entityType: "extension_installation", entityId: params.installationId, metadata: { origin, method: params.method, status: response.status } });
  return { status: response.status, headers: Object.fromEntries([...response.headers].filter(([key]) => ["content-type", "content-length"].includes(key))), body: await response.text() };
}

export async function resolveExtensionConnection(params: { workspaceId: string; installationId: string; connectionId: string; connectorFamily: string; connectorType: string; scope: string }) {
  const state = await active(params.workspaceId, params.installationId);
  const grant = (state.installation.granted_connections_json ?? []).find((item: any) => item.connectorFamily === params.connectorFamily && (!item.connectorType || item.connectorType === params.connectorType) && Array.isArray(item.scopes) && item.scopes.includes(params.scope));
  if (!grant) throw Object.assign(new Error("Typed connection capability is not granted"), { status: 403 });
  const { data, error } = await createServiceRoleClient().from("workspace_connections").select("id,name,connector_family,connector_type,status,active,environment_id").eq("workspace_id", params.workspaceId).eq("id", params.connectionId).maybeSingle();
  if (error || !data || !data.active || data.status !== "active" || data.connector_family !== params.connectorFamily || data.connector_type !== params.connectorType) throw Object.assign(new Error("Workspace connection does not satisfy the granted typed capability"), { status: 403 });
  return { id: data.id, name: data.name, connectorFamily: data.connector_family, connectorType: data.connector_type, environmentId: data.environment_id, scope: params.scope };
}

export async function emitExtensionEvent(params: { workspaceId: string; installationId: string; actorId: string; eventType: string; payload: Record<string, unknown> }) {
  const state = await active(params.workspaceId, params.installationId);
  if (!params.eventType.startsWith(`extension.${state.extensionKey}.`) || !(state.manifest.events?.emit ?? []).includes(params.eventType)) throw Object.assign(new Error("Extension may emit only its declared namespaced events"), { status: 403 });
  await logPlatformEvent({ workspaceId: params.workspaceId, actorAdminUserId: params.actorId, action: "extension.event.emitted", entityType: "extension_installation", entityId: params.installationId, metadata: { eventType: params.eventType, payloadKeys: Object.keys(params.payload).sort() } });
  return { eventType: params.eventType, extensionKey: state.extensionKey, accepted: true };
}
