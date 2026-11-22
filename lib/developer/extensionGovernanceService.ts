import { findExtensionInstallation, findExtensionManifest, insertExtensionManifest, saveExtensionInstallation } from "@/lib/developer/governanceData";
import { isCoreVersionCompatible, parseExtensionManifest, requestedExtensionPrivileges, type ExtensionManifest } from "@/lib/developer/extensionManifest";

export const CMS_CORE_VERSION = "1.0.0";

export async function registerExtensionManifest(params: { workspaceId: string; actorId: string; input: unknown; coreVersion?: string }) {
  const { manifest, sha256 } = parseExtensionManifest(params.input);
  const coreVersion = params.coreVersion ?? CMS_CORE_VERSION;
  if (!isCoreVersionCompatible(coreVersion, manifest.compatibleCoreVersions)) {
    throw Object.assign(new Error(`Extension ${manifest.extensionKey}@${manifest.version} is not compatible with core ${coreVersion}`), { status: 409 });
  }
  return insertExtensionManifest({
    workspace_id: params.workspaceId, extension_key: manifest.extensionKey, name: manifest.name, version: manifest.version,
    publisher: manifest.publisher ?? null, compatible_core_versions: manifest.compatibleCoreVersions, requested_permissions: manifest.permissions,
    routes_json: manifest.routes, events_json: manifest.events, fields_json: manifest.fields, admin_extensions_json: manifest.adminExtensions,
    network_requirements_json: manifest.networkRequirements, required_capabilities: manifest.requiredCapabilities,
    requested_connections_json: manifest.requestedConnections, manifest_json: manifest, manifest_sha256: sha256, created_by: params.actorId,
  }, (data) => ({ workspaceId: params.workspaceId, actorAdminUserId: params.actorId, action: "extension.manifest.registered", entityType: "extension_manifest", entityId: data.id, metadata: { extensionKey: manifest.extensionKey, version: manifest.version, sha256 } }));
}

export async function installExtension(params: { workspaceId: string; actorId: string; manifestId: string; grantedPermissions?: string[]; grantedNetwork?: string[]; grantedConnections?: unknown[]; configuration?: Record<string, unknown>; coreVersion?: string }) {
  const manifest = await findExtensionManifest(params.workspaceId, params.manifestId);
  if (!manifest) throw Object.assign(new Error("Extension manifest not found in workspace"), { status: 404 });
  const parsed = parseExtensionManifest(manifest.manifest_json);
  if (!isCoreVersionCompatible(params.coreVersion ?? CMS_CORE_VERSION, parsed.manifest.compatibleCoreVersions)) throw Object.assign(new Error("Extension is incompatible with this core version"), { status: 409 });
  const requested = requestedExtensionPrivileges(parsed.manifest);
  const permissions = [...new Set(params.grantedPermissions ?? [])];
  const network = [...new Set(params.grantedNetwork ?? [])];
  if (permissions.some((item) => !requested.permissions.includes(item))) throw Object.assign(new Error("Extensions may only be granted permissions they requested"), { status: 409 });
  if (network.some((item) => !requested.networkOrigins.includes(item))) throw Object.assign(new Error("Extensions may only be granted exact network origins they requested"), { status: 409 });
  const grantedConnections = Array.isArray(params.grantedConnections) ? params.grantedConnections : [];
  for (const grant of grantedConnections as Array<any>) {
    const requestedConnection = requested.requestedConnections.find((item) => item.connectorFamily === grant?.connectorFamily);
    if (!requestedConnection || (grant?.connectorType && !requestedConnection.connectorTypes.includes(String(grant.connectorType))) || !Array.isArray(grant?.scopes) || grant.scopes.some((scope: unknown) => !requestedConnection.scopes.includes(String(scope)))) {
      throw Object.assign(new Error("Extensions may only receive typed connection scopes they requested"), { status: 409 });
    }
  }
  return saveExtensionInstallation({ installation: {
    workspace_id: params.workspaceId, manifest_id: manifest.id, status: "installed", granted_permissions: permissions,
    granted_network_json: network, granted_connections_json: grantedConnections, configuration_json: params.configuration ?? {},
    installed_by: params.actorId, installed_at: new Date().toISOString(), disabled_at: null, updated_at: new Date().toISOString(),
  },
  grants: (installationId) => requested.permissions.map((permission) => ({ workspace_id: params.workspaceId, installation_id: installationId, permission_key: permission, decision: permissions.includes(permission) ? "granted" as const : "denied" as const, granted_by: params.actorId, updated_at: new Date().toISOString() })),
  audit: (data) => ({ workspaceId: params.workspaceId, actorAdminUserId: params.actorId, action: "extension.installed", entityType: "extension_installation", entityId: data.id, metadata: { manifestId: manifest.id, extensionKey: parsed.manifest.extensionKey, grantedPermissions: permissions, grantedNetwork: network } }),
  });
}

export async function getActiveExtensionPrivileges(workspaceId: string, installationId: string) {
  const data = await findExtensionInstallation(workspaceId, installationId);
  if (!data || data.status !== "installed") throw Object.assign(new Error("Extension is not active"), { status: 403 });
  return data;
}
