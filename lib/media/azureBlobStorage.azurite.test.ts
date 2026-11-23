import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { BlobServiceClient } from "@azure/storage-blob";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AzureBlobExistsError, createAzureBlobStore, verifyAzureBlobConnection, type AzureBlobStore } from "@/lib/media/azureBlobStorage";
import { enforceUploadRules } from "@/lib/media/uploadStream";

// Runs against the Azurite container that `node scripts/dev-db/setup.mjs` starts for this checkout.
// Skipped when .env.test.local has no Azurite connection string (stack not set up).

function azuriteConnectionString() {
  if (process.env.POLYNOVEA_TEST_AZURITE_CONNECTION_STRING) return process.env.POLYNOVEA_TEST_AZURITE_CONNECTION_STRING;
  const file = path.resolve(process.cwd(), ".env.test.local");
  if (!existsSync(file)) return "";
  const line = readFileSync(file, "utf8").split(/\r?\n/).find((entry) => entry.startsWith("POLYNOVEA_TEST_AZURITE_CONNECTION_STRING="));
  return line ? line.slice(line.indexOf("=") + 1).trim() : "";
}

const connectionString = azuriteConnectionString();
const container = `test-${randomUUID().slice(0, 8)}`;
const ws = "11111111-1111-4111-8111-111111111111";
const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), randomBytes(5 * 1024 * 1024)]);

describe.skipIf(!connectionString)("Azure Blob adapter against Azurite", () => {
  let store: AzureBlobStore;

  beforeAll(async () => {
    await BlobServiceClient.fromConnectionString(connectionString).getContainerClient(container).create();
    store = await createAzureBlobStore({ container, connectionString }, "local");
  });
  afterAll(async () => {
    await BlobServiceClient.fromConnectionString(connectionString).getContainerClient(container).deleteIfExists();
  });

  it("uploads, reads through a read-only SAS link, and deletes", async () => {
    const key = `${ws}/general/1-a.png`;
    await store.put(key, png.subarray(0, 1024), "image/png");
    const url = await store.readUrl(key);
    expect(new URL(url).searchParams.get("sp")).toBe("r");
    const response = await fetch(url);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await response.arrayBuffer()).equals(png.subarray(0, 1024))).toBe(true);
    // The read link cannot write.
    const write = await fetch(url, { method: "PUT", headers: { "x-ms-blob-type": "BlockBlob" }, body: "overwrite" });
    expect(write.status).toBe(403);
    await store.remove(key);
    expect((await fetch(url)).status).toBe(404);
    await expect(store.remove(key)).resolves.toBeUndefined(); // idempotent, like S3
  });

  it("streams a large upload in blocks", async () => {
    const key = `${ws}/video/2-big.png`;
    const body = Readable.from([png.subarray(0, 3_000_000), png.subarray(3_000_000)]).pipe(enforceUploadRules(png.length, "image/png"));
    await store.put(key, body, "image/png");
    expect((await store.read(key)).equals(png)).toBe(true);
  });

  it("never replaces an existing blob", async () => {
    const key = `${ws}/general/3-once.png`;
    await store.put(key, png.subarray(0, 100), "image/png");
    await expect(store.put(key, png.subarray(0, 200), "image/png")).rejects.toBeInstanceOf(AzureBlobExistsError);
    expect((await store.read(key)).length).toBe(100);
  });

  it("commits nothing when the upload stream breaks the signed size", async () => {
    const key = `${ws}/general/4-oversize.png`;
    const body = Readable.from([png.subarray(0, 4_500_000), png.subarray(4_500_000)]).pipe(enforceUploadRules(4_000_000, "image/png"));
    await expect(store.put(key, body, "image/png")).rejects.toThrow(/larger than the size/);
    await expect(store.read(key)).rejects.toThrow();
  });

  it("refuses keys that are not safe relative paths", async () => {
    await expect(store.put("../escape.png", png.subarray(0, 10), "image/png")).rejects.toThrow();
  });

  it("passes connection verification", async () => {
    const evidence = await verifyAzureBlobConnection({ container }, { connection_string: connectionString }, "local");
    expect(evidence).toMatchObject({ container, authentication: "connection-string" });
  });
});
