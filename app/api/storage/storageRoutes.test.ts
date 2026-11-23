import { randomBytes } from "node:crypto";
import { mkdtemp, readdir, rm, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeLocalObject } from "@/lib/media/localDiskStorage";
import { signedReadUrl, signedUploadUrl, signStorageToken } from "@/lib/media/signedStorageUrls";

const getStorageProvider = vi.fn();
vi.mock("@/lib/media/storageProvider", () => ({ getStorageProvider: (...args: unknown[]) => getStorageProvider(...args) }));

const { PUT } = await import("@/app/api/storage/upload/[token]/route");
const { GET, HEAD } = await import("@/app/api/storage/files/[token]/[name]/route");

const ws = "11111111-1111-4111-8111-111111111111";
const providerKey = "connection:22222222-2222-4222-8222-222222222222";
const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), randomBytes(200)]);
let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "polynovea-routes-"));
  vi.stubEnv("POLYNOVEA_STORAGE_SIGNING_KEY", randomBytes(32).toString("base64"));
  vi.stubEnv("POLYNOVEA_STORAGE_DIR", root);
  vi.stubEnv("POLYNOVEA_STORAGE_MIN_FREE_BYTES", "0");
  getStorageProvider.mockReset();
  getStorageProvider.mockResolvedValue({
    key: providerKey,
    writeStream: (input: { key: string; body: Readable; contentLength: number }) => writeLocalObject(root, input.key, input.body, { expectedBytes: input.contentLength }),
  });
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

function tokenOf(url: string, position: "last" | "beforeName") {
  const parts = url.split("/");
  return position === "last" ? parts[parts.length - 1] : parts[parts.length - 2];
}

function uploadToken(key: string, size: number, contentType = "image/png") {
  return tokenOf(signedUploadUrl({ providerKey, workspaceId: ws, key, contentType, contentLength: size }), "last");
}

function put(token: string, body: BodyInit, headers: Record<string, string>) {
  const request = new Request(`http://cms.test/api/storage/upload/${token}`, { method: "PUT", headers, body, duplex: "half" } as RequestInit);
  return PUT(request, { params: Promise.resolve({ token }) });
}

function streamOf(...chunks: Buffer[]) {
  return new ReadableStream<Uint8Array>({ start(controller) { for (const chunk of chunks) controller.enqueue(new Uint8Array(chunk)); controller.close(); } });
}

describe("PUT /api/storage/upload/[token]", () => {
  const key = `${ws}/general/1-a.png`;

  it("stores a body of exactly the signed type and size, once", async () => {
    const token = uploadToken(key, png.length);
    const response = await put(token, png, { "content-type": "image/png", "content-length": String(png.length) });
    expect(response.status).toBe(201);
    expect(getStorageProvider).toHaveBeenCalledWith({ workspaceId: ws, storageProviderKey: providerKey });
    expect(await readdir(path.join(root, ws, "general"))).toEqual(["1-a.png"]);
    const replay = await put(token, png, { "content-type": "image/png", "content-length": String(png.length) });
    expect(replay.status).toBe(409);
  });

  it("refuses an invalid, tampered or read token", async () => {
    expect((await put("nope", png, { "content-type": "image/png" })).status).toBe(403);
    const token = uploadToken(key, png.length);
    expect((await put(`${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`, png, { "content-type": "image/png" })).status).toBe(403);
    const read = signStorageToken({ o: "read", p: "local", k: key }, 60);
    expect((await put(read, png, { "content-type": "image/png" })).status).toBe(403);
  });

  it("refuses a token for a key outside its workspace", async () => {
    const token = tokenOf(signedUploadUrl({ providerKey, workspaceId: ws, key: "33333333-3333-4333-8333-333333333333/general/a.png", contentType: "image/png", contentLength: png.length }), "last");
    expect((await put(token, png, { "content-type": "image/png" })).status).toBe(403);
    expect(getStorageProvider).not.toHaveBeenCalled();
  });

  it("refuses another content type or declared length", async () => {
    const token = uploadToken(key, png.length);
    expect((await put(token, png, { "content-type": "text/html" })).status).toBe(415);
    expect((await put(token, png, { "content-type": "image/png", "content-length": String(png.length + 1) })).status).toBe(413);
  });

  it("stops a streamed body that runs past the signed size and stores nothing", async () => {
    const token = uploadToken(key, png.length);
    const response = await put(token, streamOf(png, randomBytes(4096)), { "content-type": "image/png" });
    expect(response.status).toBe(413);
    expect(await readdir(path.join(root, ws, "general"))).toEqual([]);
  });

  it("refuses bytes that are not the signed media type", async () => {
    const html = Buffer.from("<html><script>alert(document.cookie)</script></html>");
    const token = uploadToken(key, html.length);
    expect((await put(token, html, { "content-type": "image/png" })).status).toBe(415);
    expect(await readdir(path.join(root, ws, "general"))).toEqual([]);
  });

  it("refuses when the token's connection resolves to another provider", async () => {
    getStorageProvider.mockResolvedValue({ key: "connection:other", writeStream: vi.fn() });
    expect((await put(uploadToken(key, png.length), png, { "content-type": "image/png" })).status).toBe(409);
  });
});

describe("GET /api/storage/files/[token]/[name]", () => {
  const key = `${ws}/general/1-a.png`;

  function get(url: string, headers: Record<string, string> = {}, method: "GET" | "HEAD" = "GET") {
    const token = tokenOf(url, "beforeName");
    const request = new Request(`http://cms.test${url}`, { method, headers });
    const params = Promise.resolve({ token, name: "1-a.png" });
    return method === "GET" ? GET(request, { params }) : HEAD(request, { params });
  }

  it("serves the file with safe headers", async () => {
    await writeLocalObject(root, key, png);
    const response = await get(signedReadUrl(key));
    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer()).equals(png)).toBe(true);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-security-policy")).toContain("sandbox");
    expect(response.headers.get("cache-control")).toMatch(/^private, max-age=\d+$/);
  });

  it("serves byte ranges and HEAD", async () => {
    await writeLocalObject(root, key, png);
    const ranged = await get(signedReadUrl(key), { range: "bytes=2-5" });
    expect(ranged.status).toBe(206);
    expect(ranged.headers.get("content-range")).toBe(`bytes 2-5/${png.length}`);
    expect(Buffer.from(await ranged.arrayBuffer()).equals(png.subarray(2, 6))).toBe(true);
    expect((await get(signedReadUrl(key), { range: `bytes=${png.length}-` })).status).toBe(416);
    const head = await get(signedReadUrl(key), {}, "HEAD");
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe(String(png.length));
  });

  it("refuses expired, tampered and upload tokens", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-11-23T10:00:00Z"));
      await writeLocalObject(root, key, png);
      const url = signedReadUrl(key);
      vi.setSystemTime(new Date("2026-11-23T11:00:01Z"));
      expect((await get(url)).status).toBe(403);
    } finally {
      vi.useRealTimers();
    }
    const other = signedReadUrl(`${ws}/general/other.png`);
    const forged = other.replace(/files\/[^.]+/, `files/${Buffer.from(JSON.stringify({ v: 1, o: "read", p: "local", k: key, e: 9999999999 })).toString("base64url")}`);
    expect((await get(forged)).status).toBe(403);
    const upload = signedUploadUrl({ providerKey, workspaceId: ws, key, contentType: "image/png", contentLength: 10 });
    expect((await get(`${upload}/x.png`)).status).toBe(403);
  });

  it("returns 404 for a missing file and for a key that escapes the root", async () => {
    expect((await get(signedReadUrl(key))).status).toBe(404);
    expect((await get(signedReadUrl("../etc/passwd"))).status).toBe(404);
  });

  it("serves anything that is not allowlisted media as a download", async () => {
    await mkdir(path.join(root, ws, "general"), { recursive: true });
    await writeFile(path.join(root, ws, "general", "evil.html"), "<script>alert(1)</script>");
    const response = await get(signedReadUrl(`${ws}/general/evil.html`));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/octet-stream");
    expect(response.headers.get("content-disposition")).toBe("attachment");
  });
});
