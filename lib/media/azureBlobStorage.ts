import { randomUUID } from "node:crypto";
import type { Readable } from "node:stream";
import {
  BlobSASPermissions,
  BlobServiceClient,
  generateBlobSASQueryParameters,
  RestError,
  SASProtocol,
  StorageSharedKeyCredential,
  type ContainerClient,
  type UserDelegationKey,
} from "@azure/storage-blob";
import type { TokenCredential } from "@azure/identity";
import { assertSafeOutboundUrl } from "@/lib/infrastructure/networkSafety";
import type { EnvironmentKind } from "@/lib/infrastructure/types";
import { keySegments } from "@/lib/media/localDiskStorage";
import { READ_URL_TTL_SECONDS } from "@/lib/media/signedStorageUrls";

// Azure Blob Storage for installs on Azure VMs.
//
// Production authenticates with the VM's managed identity (DefaultAzureCredential, which tries the
// managed identity endpoint; set managedIdentityClientId for a user-assigned identity). No storage key
// is stored. The identity needs "Storage Blob Data Contributor" on the container, which includes the
// right to request a user delegation key.
//
// Reads are short-lived user delegation SAS URLs: read-only, one blob, HTTPS only, signed by a key
// that Entra ID issues to the identity and that we cache for under two hours. A connection string
// with an account key is accepted only for Local and Development environments (Azurite, a dev
// account), where reads are signed with the account key instead.
//
// Uploads never get a SAS. A SAS cannot bind the size of an upload, so a leaked or misused upload SAS
// could write a body of any size. Browsers instead upload to the app's own signed upload URL, which
// enforces the exact signed size and type while it streams the body into the blob (see
// app/api/storage/upload). Every write is conditional on the blob not existing (If-None-Match: *).

export const AZURE_DEV_ONLY_ENVIRONMENTS: ReadonlySet<EnvironmentKind> = new Set(["local", "development"]);
const DELEGATION_KEY_LIFETIME_MS = 2 * 60 * 60 * 1000;
const DELEGATION_KEY_MIN_REMAINING_MS = (READ_URL_TTL_SECONDS + 15 * 60) * 1000;
const START_SKEW_MS = 5 * 60 * 1000;
/** Blob service hosts of the public and sovereign Azure clouds. */
const AZURE_BLOB_HOST_SUFFIXES = [".blob.core.windows.net", ".blob.core.usgovcloudapi.net", ".blob.core.chinacloudapi.cn"];
const UPLOAD_BLOCK_BYTES = 4 * 1024 * 1024;
const UPLOAD_CONCURRENCY = 4;

export interface AzureBlobSettings {
  container: string;
  /** Account name; required unless a connection string supplies it. */
  accountName?: string;
  /** Blob service endpoint, e.g. https://<account>.blob.core.windows.net (default) or a sovereign cloud / Azurite URL. */
  endpoint?: string;
  /** Client ID of a user-assigned managed identity. */
  managedIdentityClientId?: string;
  /** Development only: connection string with AccountName and AccountKey. */
  connectionString?: string;
  /** Optional public or CDN base URL; reads then skip SAS. */
  publicUrl?: string;
}

const text = (config: Record<string, unknown>, key: string) => (typeof config[key] === "string" ? String(config[key]).trim() : "");

export function azureSettingsFrom(config: Record<string, unknown>, credentials: Record<string, string>, environmentKind: EnvironmentKind): AzureBlobSettings {
  const container = text(config, "container");
  if (!/^(?!.*--)[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(container)) throw new Error("Azure Blob container name is invalid (3-63 lowercase letters, digits and single hyphens)");
  const accountName = text(config, "accountName");
  if (accountName && !/^[a-z0-9]{3,24}$/.test(accountName)) throw new Error("Azure storage account name is invalid (3-24 lowercase letters and digits)");
  const managedIdentityClientId = text(config, "managedIdentityClientId");
  if (managedIdentityClientId && !/^[0-9a-fA-F-]{36}$/.test(managedIdentityClientId)) throw new Error("Managed identity client ID must be a GUID");
  const connectionString = credentials.connection_string?.trim() || "";
  if (connectionString && !AZURE_DEV_ONLY_ENVIRONMENTS.has(environmentKind)) {
    throw new Error("Azure connection strings are accepted only for Local and Development environments; use the VM's managed identity");
  }
  if (!connectionString && !accountName) throw new Error("Azure storage account name is required");
  return {
    container,
    accountName: accountName || undefined,
    endpoint: text(config, "endpoint").replace(/\/+$/, "") || undefined,
    managedIdentityClientId: managedIdentityClientId || undefined,
    connectionString: connectionString || undefined,
    publicUrl: text(config, "publicUrl").replace(/\/+$/, "") || undefined,
  };
}

// Credentials and delegation keys are reused across requests: the identity library caches tokens
// per credential instance, and a delegation key is good for every blob in the account.
const tokenCredentials = new Map<string, TokenCredential>();
const delegationKeys = new Map<string, { key: UserDelegationKey; expiresOn: number }>();
const pendingDelegationKeys = new Map<string, Promise<UserDelegationKey>>();

async function managedIdentityCredential(clientId: string | undefined): Promise<TokenCredential> {
  const cacheKey = clientId ?? "default";
  const cached = tokenCredentials.get(cacheKey);
  if (cached) return cached;
  const { DefaultAzureCredential } = await import("@azure/identity");
  const credential = new DefaultAzureCredential(clientId ? { managedIdentityClientId: clientId } : {});
  tokenCredentials.set(cacheKey, credential);
  return credential;
}

async function delegationKeyFor(service: BlobServiceClient, cacheKey: string, now = Date.now()): Promise<UserDelegationKey> {
  const cached = delegationKeys.get(cacheKey);
  if (cached && cached.expiresOn - now > DELEGATION_KEY_MIN_REMAINING_MS) return cached.key;
  const pending = pendingDelegationKeys.get(cacheKey);
  if (pending) return pending;
  const request = (async () => {
    const startsOn = new Date(now - START_SKEW_MS);
    const expiresOn = new Date(now + DELEGATION_KEY_LIFETIME_MS);
    const key = await service.getUserDelegationKey(startsOn, expiresOn);
    delegationKeys.set(cacheKey, { key, expiresOn: expiresOn.getTime() });
    return key;
  })();
  pendingDelegationKeys.set(cacheKey, request);
  try {
    return await request;
  } finally {
    pendingDelegationKeys.delete(cacheKey);
  }
}

export type AzureSasSigner = { kind: "user-delegation"; key: UserDelegationKey; accountName: string } | { kind: "shared-key"; credential: StorageSharedKeyCredential };

/** Read-only SAS query string for one blob. */
export function readSasQuery(input: { container: string; blobName: string; signer: AzureSasSigner; ttlSeconds?: number; allowHttp?: boolean; now?: number }) {
  const now = input.now ?? Date.now();
  const options = {
    containerName: input.container,
    blobName: input.blobName,
    permissions: BlobSASPermissions.parse("r"),
    startsOn: new Date(now - START_SKEW_MS),
    expiresOn: new Date(now + (input.ttlSeconds ?? READ_URL_TTL_SECONDS) * 1000),
    protocol: input.allowHttp ? SASProtocol.HttpsAndHttp : SASProtocol.Https,
  };
  const query = input.signer.kind === "user-delegation"
    ? generateBlobSASQueryParameters(options, input.signer.key, input.signer.accountName)
    : generateBlobSASQueryParameters(options, input.signer.credential);
  return query.toString();
}

function encodeKey(key: string) {
  return key.split("/").map(encodeURIComponent).join("/");
}

export interface AzureBlobStore {
  readonly accountName: string;
  readonly container: ContainerClient;
  readonly usesManagedIdentity: boolean;
  put(key: string, body: Buffer | Readable, contentType: string): Promise<void>;
  remove(key: string): Promise<void>;
  readUrl(key: string): Promise<string>;
  read(key: string): Promise<Buffer>;
  /** Proves the identity can mint read SAS URLs (user delegation key) or has an account key. */
  checkSigning(): Promise<void>;
}

export class AzureBlobExistsError extends Error {
  constructor() {
    super("A storage object already exists at this key");
    this.name = "AzureBlobExistsError";
  }
}

function blobName(key: string) {
  keySegments(key);
  return key;
}

/**
 * Outside Local environments the endpoint must be an Azure blob host over HTTPS. Those names are
 * Azure's DNS, so they may resolve to a private address (a Storage private endpoint in the VM's
 * network, the normal production setup) without opening a path to arbitrary internal services. The
 * generic outbound check would refuse a private endpoint, and the SDK's own HTTP stack is not the
 * guarded one, so an allowlist of hosts is the stronger rule here. Local environments (Azurite) use
 * the generic check, which allows local HTTP.
 */
export async function assertBlobEndpoint(raw: string, environmentKind: EnvironmentKind) {
  if (environmentKind === "local") {
    await assertSafeOutboundUrl(raw, environmentKind, { allowHttpLocal: true });
    return;
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Azure Blob endpoint is not a valid URL");
  }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== "https:" || url.username || url.password || url.port || !AZURE_BLOB_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
    throw new Error("Azure Blob endpoint must be https://<account>.blob.core.windows.net (or a sovereign-cloud blob host)");
  }
}

export async function createAzureBlobStore(settings: AzureBlobSettings, environmentKind: EnvironmentKind): Promise<AzureBlobStore> {
  let service: BlobServiceClient;
  let sharedKey: StorageSharedKeyCredential | null = null;
  let identityKey = "";
  if (settings.connectionString) {
    if (!AZURE_DEV_ONLY_ENVIRONMENTS.has(environmentKind)) throw new Error("Azure connection strings are accepted only for Local and Development environments");
    try {
      service = BlobServiceClient.fromConnectionString(settings.connectionString);
    } catch {
      throw new Error("Azure connection string is invalid");
    }
    if (!(service.credential instanceof StorageSharedKeyCredential)) throw new Error("Azure connection string must include AccountName and AccountKey");
    sharedKey = service.credential;
  } else {
    const endpoint = settings.endpoint || `https://${settings.accountName}.blob.core.windows.net`;
    await assertBlobEndpoint(endpoint, environmentKind);
    const credential = await managedIdentityCredential(settings.managedIdentityClientId);
    service = new BlobServiceClient(endpoint, credential);
    identityKey = `${service.url}|${settings.managedIdentityClientId ?? "default"}`;
  }
  await assertBlobEndpoint(service.url, environmentKind);
  const allowHttp = new URL(service.url).protocol === "http:";
  const container = service.getContainerClient(settings.container);
  const accountName = service.accountName;

  const signer = async (): Promise<AzureSasSigner> => sharedKey
    ? { kind: "shared-key", credential: sharedKey }
    : { kind: "user-delegation", key: await delegationKeyFor(service, identityKey), accountName };

  return {
    accountName,
    container,
    usesManagedIdentity: !sharedKey,
    async put(key, body, contentType) {
      const blob = container.getBlockBlobClient(blobName(key));
      const options = { blobHTTPHeaders: { blobContentType: contentType }, conditions: { ifNoneMatch: "*" } };
      try {
        if (Buffer.isBuffer(body)) await blob.uploadData(body, options);
        else await blob.uploadStream(body, UPLOAD_BLOCK_BYTES, UPLOAD_CONCURRENCY, options);
      } catch (error) {
        if (error instanceof RestError && (error.statusCode === 409 || error.statusCode === 412)) throw new AzureBlobExistsError();
        throw error;
      }
    },
    async remove(key) {
      await container.getBlockBlobClient(blobName(key)).deleteIfExists({ deleteSnapshots: "include" });
    },
    async readUrl(key) {
      const name = blobName(key);
      if (settings.publicUrl) return `${settings.publicUrl}/${encodeKey(name)}`;
      const query = readSasQuery({ container: settings.container, blobName: name, signer: await signer(), allowHttp });
      return `${container.getBlockBlobClient(name).url}?${query}`;
    },
    async read(key) {
      return container.getBlockBlobClient(blobName(key)).downloadToBuffer();
    },
    async checkSigning() {
      await signer();
    },
  };
}

/** Test hook: forget cached credentials and delegation keys. */
export function resetAzureCachesForTests() {
  tokenCredentials.clear();
  delegationKeys.clear();
  pendingDelegationKeys.clear();
}

/** Connection verification: container reachable, disposable blob round trip, and read-URL signing works. */
export async function verifyAzureBlobConnection(config: Record<string, unknown>, credentials: Record<string, string>, environmentKind: EnvironmentKind) {
  const settings = azureSettingsFrom(config, credentials, environmentKind);
  const store = await createAzureBlobStore(settings, environmentKind);
  await store.container.getProperties();
  // Keys never start with a dot, so this name cannot collide with media.
  const probe = store.container.getBlockBlobClient(`.polynovea-verification/${randomUUID()}.txt`);
  const body = Buffer.from(`polynovea-storage-verification:${randomUUID()}`);
  try {
    await probe.uploadData(body, { blobHTTPHeaders: { blobContentType: "text/plain" }, conditions: { ifNoneMatch: "*" } });
    const received = await probe.downloadToBuffer();
    if (!received.equals(body)) throw new Error("Storage read-back did not match the disposable verification object");
  } finally {
    await probe.deleteIfExists().catch(() => undefined);
  }
  await store.checkSigning();
  return {
    accountName: store.accountName,
    container: settings.container,
    authentication: store.usesManagedIdentity ? "managed-identity" : "connection-string",
    endpointOrigin: new URL(store.container.url).origin,
  };
}
