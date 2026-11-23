import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Which provider getStorageProvider picks, with the database lookups mocked out.

const data = vi.hoisted(() => ({
  activeStorageConnections: vi.fn(),
  defaultEnvironment: vi.fn(),
  findEnvironment: vi.fn(),
  exactStorageConnection: vi.fn(),
  environmentKind: vi.fn(),
}));
vi.mock("@/lib/media/mediaData", () => data);
vi.mock("@/lib/infrastructure/credentialProvider", () => ({ resolveConnectionCredentials: vi.fn(async () => ({})) }));

const { getStorageProvider, legacyR2Configured, SERVER_LOCAL_PROVIDER_KEY } = await import("@/lib/media/storageProvider");
const { verifyStorageToken } = await import("@/lib/media/signedStorageUrls");

const ws = "11111111-1111-4111-8111-111111111111";
const env = { id: "22222222-2222-4222-8222-222222222222", storage_provider: null, is_default: true, status: "ready", kind: "production" };
const r2Env = { R2_ACCESS_KEY_ID: "id", R2_SECRET_ACCESS_KEY: "secret", R2_ACCOUNT_ID: "account" };
let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "polynovea-select-"));
  vi.stubEnv("POLYNOVEA_STORAGE_DIR", root);
  vi.stubEnv("POLYNOVEA_STORAGE_MIN_FREE_BYTES", "0");
  vi.stubEnv("POLYNOVEA_STORAGE_SIGNING_KEY", randomBytes(32).toString("base64"));
  vi.stubEnv("POLYNOVEA_PUBLIC_URL", "https://cms.example.com");
  for (const name of ["R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_ACCOUNT_ID", "R2_S3_ENDPOINT"]) vi.stubEnv(name, "");
  for (const fn of Object.values(data)) fn.mockReset();
  data.defaultEnvironment.mockResolvedValue(env);
  data.findEnvironment.mockResolvedValue(env);
  data.activeStorageConnections.mockResolvedValue([]);
  data.environmentKind.mockResolvedValue("production");
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

function stubR2() {
  for (const [name, value] of Object.entries(r2Env)) vi.stubEnv(name, value);
}

describe("storage provider selection", () => {
  it("knows when the legacy R2 variables are complete", () => {
    expect(legacyR2Configured({})).toBe(false);
    expect(legacyR2Configured({ R2_ACCESS_KEY_ID: "a", R2_SECRET_ACCESS_KEY: "b" })).toBe(false);
    expect(legacyR2Configured(r2Env)).toBe(true);
    expect(legacyR2Configured({ R2_ACCESS_KEY_ID: "a", R2_SECRET_ACCESS_KEY: "b", R2_S3_ENDPOINT: "https://r2.example.com" })).toBe(true);
  });

  it("no connection, no R2: the server's own disk, with permanent media links bound to the workspace", async () => {
    const provider = await getStorageProvider({ workspaceId: ws });
    expect(provider.key).toBe(SERVER_LOCAL_PROVIDER_KEY);
    expect(provider.kind).toBe("storage.local");
    expect(provider.connectionId).toBeNull();
    expect(provider.environmentId).toBe(env.id);

    const key = `${ws}/general/1-a.png`;
    const body = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), randomBytes(32)]);
    const uploaded = await provider.upload({ body, key, contentType: "image/png" });
    expect((await readFile(path.join(root, ws, "general", "1-a.png"))).equals(body)).toBe(true);
    expect(uploaded.url).toMatch(/^https:\/\/cms\.example\.com\/api\/storage\/media\//);
    const token = uploaded.url.split("/")[6];
    expect(verifyStorageToken(token, "media")).toEqual({ ok: true, payload: { v: 1, o: "media", p: "local", w: ws, k: key, d: "local" } });

    const presigned = await provider.createPresignedUpload!(`${ws}/general/2-b.png`, "image/png", 100);
    const write = verifyStorageToken(presigned.uploadUrl.split("/").pop(), "write");
    expect(write.ok && write.payload).toMatchObject({ p: "local", w: ws, k: `${ws}/general/2-b.png`, n: 100 });
  });

  it("refuses keys from another workspace", async () => {
    const provider = await getStorageProvider({ workspaceId: ws });
    await expect(provider.upload({ body: Buffer.from("x"), key: "33333333-3333-4333-8333-333333333333/general/a.png", contentType: "image/png" })).rejects.toThrow(/outside this workspace/);
    await expect(provider.contentUrl("33333333-3333-4333-8333-333333333333/general/a.png")).rejects.toThrow(/outside this workspace/);
  });

  it("no connection but R2 fully configured: the existing R2 deployment is unchanged", async () => {
    stubR2();
    expect((await getStorageProvider({ workspaceId: ws })).key).toBe("r2");
  });

  it("partial R2 variables do not count as configured", async () => {
    vi.stubEnv("R2_ACCESS_KEY_ID", "id");
    expect((await getStorageProvider({ workspaceId: ws })).key).toBe(SERVER_LOCAL_PROVIDER_KEY);
  });

  it("an asset recorded as r2 still reads from R2, whatever the server default is", async () => {
    const provider = await getStorageProvider({ workspaceId: ws, storageProviderKey: "r2" });
    expect(provider.key).toBe("r2");
    expect(data.activeStorageConnections).not.toHaveBeenCalled();
  });

  it("an asset recorded as local reads from the server's disk, even once R2 or a connection exists", async () => {
    stubR2();
    data.activeStorageConnections.mockResolvedValue([{ id: "c1", workspace_id: ws, environment_id: env.id, connector_type: "storage.s3", connector_family: "storage", name: "S3", status: "active", active: true, config_json: {} }]);
    const provider = await getStorageProvider({ workspaceId: ws, storageProviderKey: "local" });
    expect(provider.key).toBe(SERVER_LOCAL_PROVIDER_KEY);
    await expect(getStorageProvider({ storageProviderKey: "local" })).rejects.toThrow(/Workspace ID is required/);
  });

  it("an active storage connection still wins over both defaults", async () => {
    stubR2();
    data.activeStorageConnections.mockResolvedValue([{ id: "44444444-4444-4444-8444-444444444444", workspace_id: ws, environment_id: env.id, connector_type: "storage.local", connector_family: "storage", name: "Disk", status: "active", active: true, config_json: {} }]);
    const provider = await getStorageProvider({ workspaceId: ws });
    expect(provider.key).toBe("connection:44444444-4444-4444-8444-444444444444");
    expect(provider.connectionId).toBe("44444444-4444-4444-8444-444444444444");
  });

  it("without a workspace: R2 when configured, otherwise a clear error instead of an R2 one", async () => {
    await expect(getStorageProvider({})).rejects.toThrow(/Workspace ID is required to choose a storage provider/);
    stubR2();
    expect((await getStorageProvider({})).key).toBe("r2");
  });

  it("an unusable storage directory fails with a message naming POLYNOVEA_STORAGE_DIR", async () => {
    const file = path.join(root, "not-a-directory");
    await writeFile(file, "x");
    vi.stubEnv("POLYNOVEA_STORAGE_DIR", path.join(file, "storage"));
    await expect(getStorageProvider({ workspaceId: ws })).rejects.toThrow(/POLYNOVEA_STORAGE_DIR/);
    vi.stubEnv("POLYNOVEA_STORAGE_DIR", "relative/path");
    await expect(getStorageProvider({ workspaceId: ws })).rejects.toThrow(/POLYNOVEA_STORAGE_DIR/);
  });
});
