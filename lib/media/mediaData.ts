// Media area: database primitives for assets, replacement, the upload quota and storage resolution,
// with the backend dispatcher (the `media` switch in POLYNOVEA_DATA_BACKEND). The services
// (assetService, replacementService, uploadLimits, storageProvider) keep their validation, upload
// and storage logic and call these, so both paths apply the same rules.
import { usesDirectPostgres } from "@/lib/db/backend";
import type { EnvironmentKind } from "@/lib/infrastructure/types";
import * as postgres from "@/lib/media/mediaData.postgres";
import * as supabase from "@/lib/media/mediaData.supabase";

export interface StorageConnectionRow {
  id: string;
  workspace_id: string;
  environment_id: string;
  connector_type: string;
  connector_family: string;
  name: string;
  status: string;
  active: boolean;
  config_json: Record<string, unknown>;
}

export interface EnvironmentRow {
  id: string;
  storage_provider: string | null;
  is_default: boolean;
  status: string;
  kind: EnvironmentKind;
}

export interface NewAssetRow {
  workspace_id: string;
  storage_provider: string;
  storage_key: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
  checksum: string;
  alt_text: string | null;
  caption: string | null;
  folder: string;
  metadata_json: Record<string, unknown>;
  created_by: string;
}

export interface ReplaceAssetFileArgs {
  workspaceId: string;
  actorId: string;
  assetId: string;
  storageProvider: string;
  storageKey: string;
  checksum: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  reason: string;
}

// Compile-time check that the direct implementation matches the Supabase one exactly.
const direct: typeof supabase = postgres;
const impl = (): typeof supabase => (usesDirectPostgres("media") ? direct : supabase);

export const listActiveAssets: typeof supabase.listActiveAssets = (...args) => impl().listActiveAssets(...args);
export const findActiveAssetByChecksum: typeof supabase.findActiveAssetByChecksum = (...args) => impl().findActiveAssetByChecksum(...args);
export const insertAsset: typeof supabase.insertAsset = (...args) => impl().insertAsset(...args);
export const findAsset: typeof supabase.findAsset = (...args) => impl().findAsset(...args);
export const replaceAssetFile: typeof supabase.replaceAssetFile = (...args) => impl().replaceAssetFile(...args);
export const listAssetReplacements: typeof supabase.listAssetReplacements = (...args) => impl().listAssetReplacements(...args);
export const activeAssetBytes: typeof supabase.activeAssetBytes = (...args) => impl().activeAssetBytes(...args);
export const environmentKind: typeof supabase.environmentKind = (...args) => impl().environmentKind(...args);
export const exactStorageConnection: typeof supabase.exactStorageConnection = (...args) => impl().exactStorageConnection(...args);
export const findEnvironment: typeof supabase.findEnvironment = (...args) => impl().findEnvironment(...args);
export const defaultEnvironment: typeof supabase.defaultEnvironment = (...args) => impl().defaultEnvironment(...args);
export const activeStorageConnections: typeof supabase.activeStorageConnections = (...args) => impl().activeStorageConnections(...args);
