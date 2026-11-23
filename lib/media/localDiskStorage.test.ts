import { mkdtemp, mkdir, readdir, readFile, rm, statfs, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { buffer } from "node:stream/consumers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  inFlightUploadBytes,
  keySegments,
  lexicalPath,
  localStorageRoot,
  openLocalObject,
  parseRange,
  probeLocalStorage,
  removeLocalObject,
  servedContentType,
  StorageKeyError,
  StorageObjectExistsError,
  StorageObjectNotFoundError,
  writeLocalObject,
} from "@/lib/media/localDiskStorage";

const ws = "11111111-1111-4111-8111-111111111111";
const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.from("rest-of-image")]);
const noReserve = { POLYNOVEA_STORAGE_MIN_FREE_BYTES: "0" };
let base: string;
let root: string;
let outside: string;

beforeEach(async () => {
  base = await mkdtemp(path.join(os.tmpdir(), "polynovea-storage-"));
  root = path.join(base, "root");
  outside = path.join(base, "outside");
  await mkdir(root);
  await mkdir(outside);
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

/** Directory symlink that works without admin rights on Windows (junction). */
async function linkDirectory(target: string, at: string) {
  await symlink(target, at, process.platform === "win32" ? "junction" : "dir");
}

describe("storage keys as paths", () => {
  it("accepts the keys the CMS generates", () => {
    expect(keySegments(`${ws}/general/1732350000000-abc123.png`)).toHaveLength(3);
    expect(keySegments(`${ws}/blog/1732350000000-0123456789ab-photo.final.jpeg`)).toHaveLength(3);
  });

  it("refuses traversal, absolute, hidden and odd keys", () => {
    const bad = [
      "", "file.png", "../etc/passwd", `${ws}/../../etc/passwd`, `${ws}/./a.png`, `/${ws}/a.png`, `${ws}//a.png`, `${ws}/a.png/`,
      `${ws}\\..\\a.png`, `${ws}/.htaccess`, `${ws}/C:/a.png`, `C:\\Windows\\a.png`, `${ws}/a%2e%2e/b`, `${ws}/a b.png`, `${ws}/a\u0000.png`,
      `${ws}/${"x".repeat(256)}`, `${ws}/${"a/".repeat(600)}x`, 42, null,
    ];
    for (const key of bad) expect(() => keySegments(key), String(key)).toThrow(StorageKeyError);
  });

  it("resolves only inside the root", () => {
    expect(lexicalPath(root, `${ws}/general/a.png`)).toBe(path.join(root, ws, "general", "a.png"));
    expect(() => lexicalPath(root, "../outside/a.png")).toThrow(StorageKeyError);
  });

  it("requires an absolute configured root and defaults to /var/lib/polynovea/storage", () => {
    expect(() => localStorageRoot({ POLYNOVEA_STORAGE_DIR: "relative/dir" })).toThrow(/absolute/);
    expect(localStorageRoot({})).toBe(path.resolve("/var/lib/polynovea/storage"));
  });
});

describe("local disk objects", () => {
  const key = `${ws}/general/1-a.png`;

  it("writes, reads back and deletes an object", async () => {
    await writeLocalObject(root, key, png, { env: noReserve });
    const object = await openLocalObject(root, key);
    expect(object.size).toBe(png.length);
    expect((await buffer(object.stream())).equals(png)).toBe(true);
    await removeLocalObject(root, key);
    await expect(openLocalObject(root, key)).rejects.toBeInstanceOf(StorageObjectNotFoundError);
    await expect(removeLocalObject(root, key)).resolves.toBeUndefined(); // deleting twice is fine, like S3
  });

  it("streams large bodies and reads byte ranges", async () => {
    const big = Buffer.alloc(3 * 1024 * 1024 + 17, 7);
    big.set(png.subarray(0, 8));
    await writeLocalObject(root, key, Readable.from([big.subarray(0, 1_000_000), big.subarray(1_000_000)]), { expectedBytes: big.length, env: noReserve });
    const object = await openLocalObject(root, key);
    const part = await buffer(object.stream({ start: 10, end: 19 }));
    expect(part.equals(big.subarray(10, 20))).toBe(true);
  });

  it("never replaces an existing object", async () => {
    await writeLocalObject(root, key, png, { env: noReserve });
    await expect(writeLocalObject(root, key, Buffer.from("other"), { env: noReserve })).rejects.toBeInstanceOf(StorageObjectExistsError);
    expect((await readFile(path.join(root, ws, "general", "1-a.png"))).equals(png)).toBe(true);
  });

  it("leaves nothing behind when the body stream fails", async () => {
    const failing = new Readable({ read() { this.push(png); this.destroy(new Error("client went away")); } });
    await expect(writeLocalObject(root, key, failing, { env: noReserve })).rejects.toThrow(/client went away/);
    expect(await readdir(path.join(root, ws, "general"))).toEqual([]);
  });

  it("refuses writes that would leave less than the reserved free space", async () => {
    await expect(writeLocalObject(root, key, png, { env: { POLYNOVEA_STORAGE_MIN_FREE_BYTES: String(Number.MAX_SAFE_INTEGER) } })).rejects.toThrow(/free space/);
  });

  it("refuses to write or read through a symlinked directory that leaves the root", async () => {
    await linkDirectory(outside, path.join(root, ws));
    await expect(writeLocalObject(root, key, png, { env: noReserve })).rejects.toBeInstanceOf(StorageKeyError);
    expect(await readdir(outside)).toEqual([]);
    await mkdir(path.join(outside, "general"));
    await writeFile(path.join(outside, "general", "1-a.png"), "secret");
    await expect(openLocalObject(root, key)).rejects.toBeInstanceOf(StorageKeyError);
    await removeLocalObject(root, key).catch(() => undefined);
    expect(await readFile(path.join(outside, "general", "1-a.png"), "utf8")).toBe("secret");
  });

  it("refuses to read a symlinked file that points outside the root", async (context) => {
    await writeFile(path.join(outside, "secret.png"), "secret");
    await mkdir(path.join(root, ws, "general"), { recursive: true });
    try {
      await symlink(path.join(outside, "secret.png"), path.join(root, ws, "general", "1-a.png"), "file");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") return context.skip(); // Windows without symlink rights
      throw error;
    }
    await expect(openLocalObject(root, key)).rejects.toThrow();
  });

  it("probes a writable root (including a hard link, which uploads rely on) and reports free space", async () => {
    const probe = await probeLocalStorage(root, noReserve);
    expect(probe.availableBytes).toBeGreaterThan(0);
    expect(await readdir(path.join(root, ".polynovea-verification"))).toEqual([]);
  });

  it("counts in-flight uploads against free space and releases them, on success and on failure", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const slow = new Readable({ read() {} });
    const writing = writeLocalObject(root, key, slow, { expectedBytes: 5000, env: noReserve });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(inFlightUploadBytes()).toBe(5000);
    // A second upload is checked against free space minus the 5000 bytes already promised.
    const info = await statfs(root);
    const available = Number(info.bavail) * Number(info.bsize);
    const reserve = { POLYNOVEA_STORAGE_MIN_FREE_BYTES: String(available - 6000) };
    await expect(writeLocalObject(root, `${ws}/general/2-b.png`, Buffer.alloc(2000), { env: reserve })).rejects.toThrow(/free space/);
    void gate.then(() => { slow.push(Buffer.alloc(5000)); slow.push(null); });
    release();
    await writing;
    expect(inFlightUploadBytes()).toBe(0);
    await expect(writeLocalObject(root, `${ws}/general/3-c.png`, new Readable({ read() { this.destroy(new Error("gone")); } }), { expectedBytes: 10, env: noReserve })).rejects.toThrow();
    expect(inFlightUploadBytes()).toBe(0);
  });
});

describe("range parsing", () => {
  it("handles single ranges and refuses unsatisfiable ones", () => {
    expect(parseRange(null, 100)).toBeNull();
    expect(parseRange("bytes=0-9", 100)).toEqual({ start: 0, end: 9 });
    expect(parseRange("bytes=90-", 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange("bytes=-10", 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange("bytes=50-500", 100)).toEqual({ start: 50, end: 99 });
    expect(parseRange("bytes=100-", 100)).toBe("invalid");
    expect(parseRange("bytes=9-1", 100)).toBe("invalid");
    expect(parseRange("bytes=-", 100)).toBe("invalid");
    expect(parseRange("bytes=0-1,5-6", 100)).toBeNull();
    expect(parseRange("items=0-1", 100)).toBeNull();
  });
});

describe("served content type", () => {
  it("comes from the bytes, never from the name alone", () => {
    expect(servedContentType("x/a.png", png)).toEqual({ contentType: "image/png", inline: true });
    expect(servedContentType("x/a.png", Buffer.from("<svg onload=alert(1)>"))).toEqual({ contentType: "application/octet-stream", inline: false });
    expect(servedContentType("x/a.html", Buffer.from("<html>"))).toEqual({ contentType: "application/octet-stream", inline: false });
    const ftyp = Buffer.from("\0\0\0\x18ftypqt  ", "latin1");
    expect(servedContentType("x/a.mov", ftyp).contentType).toBe("video/quicktime");
    expect(servedContentType("x/a.mp4", ftyp).contentType).toBe("video/mp4");
    // PDFs download: the sandbox CSP breaks browser PDF viewers.
    expect(servedContentType("x/a.pdf", Buffer.from("%PDF-1.7"))).toEqual({ contentType: "application/pdf", inline: false });
  });
});
