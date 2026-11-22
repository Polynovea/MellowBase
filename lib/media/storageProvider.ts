import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { createClient } from "@supabase/supabase-js";
import { resolveConnectionCredentials } from "@/lib/infrastructure/credentialProvider";
import { allowsPrivateNetwork, assertSafeOutboundUrl } from "@/lib/infrastructure/networkSafety";
import type { EnvironmentKind } from "@/lib/infrastructure/types";
import { deleteObject, resolveObjectUrl, uploadObject, createPresignedUpload as createLegacyR2PresignedUpload } from "@/lib/r2Storage";
import { guardedFetchFor, guardedS3RequestHandler } from "@/lib/infrastructure/guardedNetwork";
import { activeStorageConnections, defaultEnvironment, environmentKind as environmentKindOf, exactStorageConnection, findEnvironment, type EnvironmentRow, type StorageConnectionRow } from "@/lib/media/mediaData";

export interface StorageProvider {
  readonly key: string;
  readonly kind: string;
  readonly connectionId: string | null;
  readonly environmentId: string | null;
  upload(input: { body: Buffer; key: string; contentType: string }): Promise<{ key: string; url: string }>;
  remove(key: string): Promise<void>;
  resolveReadUrl(key: string): Promise<string>;
  /** contentLength is signed into the URL, so the provider rejects a body of any other size. */
  createPresignedUpload?(key: string, contentType: string, contentLength: number): Promise<{ uploadUrl: string; readUrl: string }>;
}

function configText(config: Record<string, unknown>, key: string) {
  return typeof config[key] === "string" ? String(config[key]).trim() : "";
}

function boolConfig(config: Record<string, unknown>, key: string, fallback = false) {
  const value = config[key];
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return ["1", "true", "yes", "on"].includes(value.toLowerCase());
  return fallback;
}

function trimSlash(value: string) {
  return value.replace(/\/+$/, "");
}

function encodeStorageKey(key: string) {
  return key.split("/").map(encodeURIComponent).join("/");
}

function connectionKey(id: string) {
  return `connection:${id}`;
}

function aliasesFor(type: string) {
  if (type === "storage.r2") return new Set(["r2", "cloudflare-r2", "cloudflare_r2", type]);
  if (type === "storage.s3") return new Set(["s3", "aws-s3", "aws_s3", type]);
  if (type === "storage.minio") return new Set(["minio", type]);
  if (type === "storage.supabase") return new Set(["supabase", "supabase-storage", "supabase_storage", type]);
  return new Set([type]);
}

function legacyR2Provider(): StorageProvider {
  return {
    key: "r2",
    kind: "storage.r2",
    connectionId: null,
    environmentId: null,
    async upload(input) {
      return { key: input.key, url: await uploadObject(input.body, input.key, input.contentType) };
    },
    remove: deleteObject,
    async resolveReadUrl(key) {
      return resolveObjectUrl(key);
    },
    createPresignedUpload: createLegacyR2PresignedUpload,
  };
}

async function s3Provider(connection: StorageConnectionRow, credentials: Record<string, string>, environmentKind: EnvironmentKind): Promise<StorageProvider> {
  const config = connection.config_json ?? {};
  const type = connection.connector_type;
  const bucket = configText(config, "bucket");
  if (!bucket) throw new Error(`${connection.name}: storage bucket is not configured`);

  let region = configText(config, "region") || "us-east-1";
  let endpoint = configText(config, "endpoint") || configText(config, "endpointUrl") || undefined;
  let accessKeyId = credentials.access_key_id || configText(config, "accessKeyId");
  const secretAccessKey = credentials.secret_access_key;
  let forcePathStyle = boolConfig(config, "forcePathStyle", false);

  if (type === "storage.r2") {
    const accountId = configText(config, "accountId");
    if (!accountId) throw new Error(`${connection.name}: R2 account ID is not configured`);
    endpoint = endpoint || `https://${accountId}.r2.cloudflarestorage.com`;
    region = "auto";
  }
  if (type === "storage.minio") {
    if (!endpoint) throw new Error(`${connection.name}: MinIO endpoint is not configured`);
    forcePathStyle = true;
  }
  if (!accessKeyId || !secretAccessKey) throw new Error(`${connection.name}: storage access credentials are incomplete`);
  if (endpoint) await assertSafeOutboundUrl(endpoint, environmentKind, { allowHttpLocal: true });

  const client = new S3Client({
    region,
    endpoint,
    forcePathStyle,
    credentials: { accessKeyId, secretAccessKey },
    requestHandler: guardedS3RequestHandler({ allowPrivate: allowsPrivateNetwork(environmentKind) }),
  });
  const publicUrl = trimSlash(configText(config, "publicUrl"));

  const resolveReadUrl = async (key: string) => {
    if (publicUrl) return `${publicUrl}/${encodeStorageKey(key)}`;
    return getSignedUrl(client, new GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn: 3600 });
  };

  return {
    key: connectionKey(connection.id),
    kind: type,
    connectionId: connection.id,
    environmentId: connection.environment_id,
    async upload(input) {
      await client.send(new PutObjectCommand({ Bucket: bucket, Key: input.key, Body: input.body, ContentType: input.contentType }));
      return { key: input.key, url: await resolveReadUrl(input.key) };
    },
    async remove(key) {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    },
    resolveReadUrl,
    async createPresignedUpload(key, contentType, contentLength) {
      const uploadUrl = await getSignedUrl(client, new PutObjectCommand({ Bucket: bucket, Key: key, ContentType: contentType, ContentLength: contentLength }), { expiresIn: 900, signableHeaders: new Set(["content-type", "content-length"]) });
      return { uploadUrl, readUrl: await resolveReadUrl(key) };
    },
  };
}

async function supabaseStorageProvider(connection: StorageConnectionRow, credentials: Record<string, string>, environmentKind: EnvironmentKind): Promise<StorageProvider> {
  const config = connection.config_json ?? {};
  const projectUrl = trimSlash(configText(config, "projectUrl"));
  const bucket = configText(config, "bucket");
  const key = credentials.service_role_key || credentials.anon_key;
  if (!projectUrl || !bucket || !key) throw new Error(`${connection.name}: Supabase Storage configuration is incomplete`);
  await assertSafeOutboundUrl(projectUrl, environmentKind, { allowHttpLocal: true });
  const client = createClient(projectUrl, key, { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: guardedFetchFor({ allowPrivate: allowsPrivateNetwork(environmentKind) }) } });
  const visibility = configText(config, "visibility") || "private";
  const configuredPublicUrl = trimSlash(configText(config, "publicUrl"));

  const resolveReadUrl = async (path: string) => {
    if (configuredPublicUrl) return `${configuredPublicUrl}/${encodeStorageKey(path)}`;
    if (visibility === "public") return client.storage.from(bucket).getPublicUrl(path).data.publicUrl;
    const { data, error } = await client.storage.from(bucket).createSignedUrl(path, 3600);
    if (error || !data?.signedUrl) throw new Error(error?.message || "Could not create Supabase Storage read URL");
    return data.signedUrl;
  };

  return {
    key: connectionKey(connection.id),
    kind: connection.connector_type,
    connectionId: connection.id,
    environmentId: connection.environment_id,
    async upload(input) {
      const { error } = await client.storage.from(bucket).upload(input.key, input.body, { contentType: input.contentType, upsert: false });
      if (error) throw new Error(error.message);
      return { key: input.key, url: await resolveReadUrl(input.key) };
    },
    async remove(path) {
      const { error } = await client.storage.from(bucket).remove([path]);
      if (error) throw new Error(error.message);
    },
    resolveReadUrl,
  };
}

async function providerFromConnection(workspaceId: string, connection: StorageConnectionRow): Promise<StorageProvider> {
  if (connection.workspace_id !== workspaceId || connection.connector_family !== "storage") throw new Error("Storage connection is outside the workspace boundary");
  if (!connection.active || connection.status !== "active") throw new Error(`${connection.name}: storage connection is not active; verify/reconnect it first`);
  const kind = await environmentKindOf(workspaceId, connection.environment_id);
  if (!kind) throw new Error("Storage connection environment is unavailable");
  const environmentKind = kind as EnvironmentKind;
  const credentials = await resolveConnectionCredentials(workspaceId, connection.id);
  if (["storage.r2", "storage.s3", "storage.minio"].includes(connection.connector_type)) return s3Provider(connection, credentials, environmentKind);
  if (connection.connector_type === "storage.supabase") return supabaseStorageProvider(connection, credentials, environmentKind);
  throw new Error(`Storage connector ${connection.connector_type} has no media data-plane adapter`);
}

async function exactConnection(workspaceId: string, id: string) {
  return exactStorageConnection(workspaceId, id);
}

async function selectEnvironment(workspaceId: string, environmentId?: string | null): Promise<EnvironmentRow | null> {
  if (environmentId) {
    const environment = await findEnvironment(workspaceId, environmentId);
    if (!environment) throw new Error("Storage environment was not found in the workspace");
    return environment;
  }
  return defaultEnvironment(workspaceId);
}

async function selectActiveStorageConnection(workspaceId: string, environment: EnvironmentRow | null) {
  const rows = await activeStorageConnections(workspaceId, environment?.id ?? null);
  if (!rows.length) return null;
  const preferred = environment?.storage_provider?.trim();
  if (!preferred) return rows[0];
  if (preferred.startsWith("connection:")) return rows.find((row) => row.id === preferred.slice("connection:".length)) ?? rows[0];
  return rows.find((row) => row.id === preferred || aliasesFor(row.connector_type).has(preferred.toLowerCase())) ?? rows[0];
}

export async function getStorageProvider(params: {
  workspaceId?: string;
  environmentId?: string | null;
  storageProviderKey?: string | null;
} = {}): Promise<StorageProvider> {
  const workspaceId = params.workspaceId;
  const storedKey = params.storageProviderKey?.trim() || null;

  if (storedKey?.startsWith("connection:")) {
    if (!workspaceId) throw new Error("Workspace ID is required to resolve a connection-backed asset");
    const connection = await exactConnection(workspaceId, storedKey.slice("connection:".length));
    if (!connection) throw new Error("The storage connection recorded for this asset no longer exists");
    return providerFromConnection(workspaceId, connection);
  }

  if (storedKey === "r2" && !params.environmentId) return legacyR2Provider();
  if (!workspaceId) return legacyR2Provider();

  const environment = await selectEnvironment(workspaceId, params.environmentId);
  const connection = await selectActiveStorageConnection(workspaceId, environment);
  if (connection) return providerFromConnection(workspaceId, connection);

  // Preserve Polynovea's existing deployment while OSS/environment installs move to first-class Connections.
  if (process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY && (process.env.R2_ACCOUNT_ID || process.env.R2_S3_ENDPOINT)) return legacyR2Provider();

  throw new Error("No active storage connection is configured for this environment. Open Connections, add/verify storage, then retry.");
}
