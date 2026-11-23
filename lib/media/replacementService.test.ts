import { randomBytes } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// replaceAsset's storage choice, with the database mocked: the path certify-phase7-authenticated-api
// section 7 drives (an asset recorded as "r2" replaced on an install without the R2_* variables).

const data = vi.hoisted(() => ({
  findAsset: vi.fn(),
  replaceAssetFile: vi.fn(),
  listAssetReplacements: vi.fn(),
  activeStorageConnections: vi.fn(),
  defaultEnvironment: vi.fn(),
  findEnvironment: vi.fn(),
  exactStorageConnection: vi.fn(),
  environmentKind: vi.fn(),
}));
const r2 = vi.hoisted(() => ({
  uploadObject: vi.fn(async (_body: Buffer, key: string) => `https://r2.example.com/${key}`),
  deleteObject: vi.fn(),
  resolveObjectUrl: vi.fn((key: string) => `https://r2.example.com/${key}`),
  createPresignedUpload: vi.fn(),
}));
vi.mock("@/lib/media/mediaData", () => data);
vi.mock("@/lib/r2Storage", () => r2);
vi.mock("@/lib/infrastructure/credentialProvider", () => ({ resolveConnectionCredentials: vi.fn(async () => ({})) }));

const { replaceAsset, replacementTargetKey } = await import("@/lib/media/replacementService");

const ws = "11111111-1111-4111-8111-111111111111";
const assetId = "55555555-5555-4555-8555-555555555555";
const env = { id: "22222222-2222-4222-8222-222222222222", storage_provider: null, is_default: true, status: "ready", kind: "production" };
let root: string;

/** The 24-byte PNG header the certify script sends: 120 x 80. */
function certifyPng() {
  const png = Buffer.alloc(24);
  png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  png.writeUInt32BE(120, 16);
  png.writeUInt32BE(80, 20);
  return new File([png], "replaced-hero.png", { type: "image/png" });
}

function assetRecordedOn(storageProvider: string) {
  return { id: assetId, workspace_id: ws, storage_provider: storageProvider, storage_key: "key-old.png", filename: "initial-hero.png", mime_type: "image/png", size_bytes: 512, checksum: "old", folder: "general", width: 100, height: 100 };
}

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "polynovea-replace-"));
  vi.stubEnv("POLYNOVEA_STORAGE_DIR", root);
  vi.stubEnv("POLYNOVEA_STORAGE_MIN_FREE_BYTES", "0");
  vi.stubEnv("POLYNOVEA_STORAGE_SIGNING_KEY", randomBytes(32).toString("base64"));
  for (const name of ["R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_ACCOUNT_ID", "R2_S3_ENDPOINT"]) vi.stubEnv(name, "");
  for (const fn of [...Object.values(data), ...Object.values(r2)]) fn.mockClear();
  data.defaultEnvironment.mockResolvedValue(env);
  data.findEnvironment.mockResolvedValue(env);
  data.activeStorageConnections.mockResolvedValue([]);
  data.environmentKind.mockResolvedValue("production");
  data.replaceAssetFile.mockImplementation(async (input: Record<string, unknown>) => ({
    ok: true,
    asset: { id: assetId, storage_provider: input.storageProvider, storage_key: input.storageKey, width: input.width, height: input.height },
    replacement: { new_storage_provider: input.storageProvider, new_width: input.width, new_height: input.height },
  }));
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

describe("asset replacement storage", () => {
  it("replaces an asset recorded as r2 on an install without R2: the new file goes to the server disk", async () => {
    data.findAsset.mockResolvedValue(assetRecordedOn("r2"));
    const result = await replaceAsset({ workspaceId: ws, actorAdminUserId: "admin", assetId, file: certifyPng(), reason: "certify" });
    expect(result.ok).toBe(true);
    expect(r2.uploadObject).not.toHaveBeenCalled();
    const call = data.replaceAssetFile.mock.calls[0][0];
    expect(call).toMatchObject({ storageProvider: "local", width: 120, height: 80, mimeType: "image/png" });
    const written = await readFile(path.join(root, ...String(call.storageKey).split("/")));
    expect(written.length).toBe(24);
    expect(await readdir(path.join(root, ws, "general"))).toHaveLength(1);
  });

  it("keeps an r2 asset on R2 when the install still has R2 configured", async () => {
    for (const [name, value] of Object.entries({ R2_ACCESS_KEY_ID: "id", R2_SECRET_ACCESS_KEY: "secret", R2_ACCOUNT_ID: "account" })) vi.stubEnv(name, value);
    data.findAsset.mockResolvedValue(assetRecordedOn("r2"));
    const result = await replaceAsset({ workspaceId: ws, actorAdminUserId: "admin", assetId, file: certifyPng() });
    expect(result.ok).toBe(true);
    expect(r2.uploadObject).toHaveBeenCalledTimes(1);
    expect(data.replaceAssetFile.mock.calls[0][0]).toMatchObject({ storageProvider: "r2" });
  });

  it("keeps an asset on its own connection or the server disk", async () => {
    data.findAsset.mockResolvedValue(assetRecordedOn("local"));
    expect((await replaceAsset({ workspaceId: ws, actorAdminUserId: "admin", assetId, file: certifyPng() })).ok).toBe(true);
    expect(data.replaceAssetFile.mock.calls[0][0]).toMatchObject({ storageProvider: "local" });

    const connectionId = "44444444-4444-4444-8444-444444444444";
    data.exactStorageConnection.mockResolvedValue({ id: connectionId, workspace_id: ws, environment_id: env.id, connector_type: "storage.local", connector_family: "storage", name: "Disk", status: "active", active: true, config_json: {} });
    data.findAsset.mockResolvedValue(assetRecordedOn(`connection:${connectionId}`));
    expect((await replaceAsset({ workspaceId: ws, actorAdminUserId: "admin", assetId, file: certifyPng() })).ok).toBe(true);
    expect(data.replaceAssetFile.mock.calls[1][0]).toMatchObject({ storageProvider: `connection:${connectionId}` });
  });

  it("chooses the write target from the stored provider and the R2 variables", () => {
    expect(replacementTargetKey("r2", {})).toBeNull();
    expect(replacementTargetKey("r2", { R2_ACCESS_KEY_ID: "a", R2_SECRET_ACCESS_KEY: "b", R2_S3_ENDPOINT: "https://r2" })).toBe("r2");
    expect(replacementTargetKey("local", {})).toBe("local");
    expect(replacementTargetKey("connection:x", {})).toBe("connection:x");
    expect(replacementTargetKey(null, {})).toBeNull();
  });
});
