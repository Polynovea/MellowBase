import { randomBytes } from "node:crypto";
import { constants as fsConstants, type ReadStream } from "node:fs";
import { link, lstat, mkdir, open, realpath, rm, statfs, unlink } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

// Media files on the server's own data disk, for the "on this server" install that has no bucket.
//
// Layout: <root>/<storage key>, where every key starts with the workspace ID. The root is
// POLYNOVEA_STORAGE_DIR (default /var/lib/polynovea/storage) and belongs in the server's backup set
// next to the database (see docs/self-hosting/storage.md).
//
// Keys are never trusted as paths. A key must be a plain relative path of safe segments; it is
// resolved under the root, and the real path of the directory (or file) it lands in must still be
// inside the real path of the root, so neither "..", absolute paths nor a symlink planted inside the
// root can move a read or write outside it. The last path component is opened with O_NOFOLLOW where
// the platform has it. Writes go to a temporary file in the same directory and are linked into place
// only when the stream finished cleanly, and never over an existing object.

export const DEFAULT_STORAGE_ROOT = "/var/lib/polynovea/storage";
const DEFAULT_MIN_FREE_BYTES = 1024 * 1024 * 1024;
const MAX_KEY_LENGTH = 1024;
const SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,254}$/;
const TEMP_PREFIX = ".upload-";

type Env = Record<string, string | undefined>;

export class StorageKeyError extends Error {
  constructor(message = "Storage key is not a safe relative path") {
    super(message);
    this.name = "StorageKeyError";
  }
}

export class StorageObjectNotFoundError extends Error {
  constructor() {
    super("Storage object was not found");
    this.name = "StorageObjectNotFoundError";
  }
}

export class StorageObjectExistsError extends Error {
  constructor() {
    super("A storage object already exists at this key");
    this.name = "StorageObjectExistsError";
  }
}

export function localStorageRoot(env: Env = process.env): string {
  const configured = env.POLYNOVEA_STORAGE_DIR?.trim();
  const root = configured || DEFAULT_STORAGE_ROOT;
  if (!path.isAbsolute(root)) throw new Error("POLYNOVEA_STORAGE_DIR must be an absolute path");
  return path.resolve(root);
}

function minFreeBytes(env: Env = process.env) {
  const raw = env.POLYNOVEA_STORAGE_MIN_FREE_BYTES?.trim();
  if (!raw) return DEFAULT_MIN_FREE_BYTES;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("POLYNOVEA_STORAGE_MIN_FREE_BYTES must be a non-negative integer");
  return value;
}

/** Splits a key into validated path segments, or throws StorageKeyError. */
export function keySegments(key: unknown): string[] {
  if (typeof key !== "string" || key.length === 0 || key.length > MAX_KEY_LENGTH) throw new StorageKeyError();
  const segments = key.split("/");
  if (segments.length < 2 || !segments.every((segment) => SEGMENT.test(segment) && segment !== "." && segment !== "..")) throw new StorageKeyError();
  return segments;
}

function isInside(root: string, candidate: string) {
  const relative = path.relative(root, candidate);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

/** Lexical resolution of a key under the root; does not touch the disk. */
export function lexicalPath(root: string, key: unknown): string {
  const target = path.resolve(root, ...keySegments(key));
  if (!isInside(root, target)) throw new StorageKeyError();
  return target;
}

async function realRoot(root: string) {
  await mkdir(root, { recursive: true, mode: 0o750 });
  return realpath(root);
}

/** Ensures the object's directory exists and really is inside the root (no symlinked directories out). */
async function safeDirectoryFor(root: string, key: string) {
  const rootReal = await realRoot(root);
  const segments = keySegments(key);
  // One level at a time, never following a link: `mkdir -p` would follow a symlinked directory and
  // create directories outside the root before any check could run.
  let directory = rootReal;
  for (const segment of segments.slice(0, -1)) {
    directory = path.join(directory, segment);
    try {
      await mkdir(directory, { mode: 0o750 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const info = await lstat(directory);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new StorageKeyError();
  }
  const directoryReal = await realpath(directory);
  if (!isInside(rootReal, directoryReal)) throw new StorageKeyError();
  return { target: path.join(directoryReal, segments[segments.length - 1]), directory: directoryReal };
}

/** Resolves an existing object to its real path, refusing anything that is not a regular file inside the root. */
async function existingObjectPath(root: string, key: string) {
  let rootReal: string;
  try {
    rootReal = await realpath(root);
  } catch {
    throw new StorageObjectNotFoundError();
  }
  const target = lexicalPath(rootReal, key);
  let real: string;
  try {
    const info = await lstat(target);
    if (!info.isFile()) throw new StorageObjectNotFoundError();
    real = await realpath(target);
  } catch (error) {
    if (error instanceof StorageObjectNotFoundError) throw error;
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ENOTDIR") throw new StorageObjectNotFoundError();
    throw error;
  }
  if (!isInside(rootReal, real)) throw new StorageKeyError();
  return real;
}

const NOFOLLOW = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;

/** Bytes reserved by uploads in progress in this process. */
let inFlightBytes = 0;

/**
 * The database may share this disk; never let uploads fill it. Bytes promised to uploads still in
 * flight count as used, so concurrent uploads cannot each pass the check and together overrun it. The
 * check and the reservation happen in one synchronous step after statfs, so no other upload's check
 * runs in between. The caller releases the reservation when its write ends.
 */
async function reserveFreeSpace(directory: string, incomingBytes: number, env: Env) {
  const reserve = minFreeBytes(env);
  if (reserve > 0) {
    const info = await statfs(directory);
    const available = Number(info.bavail) * Number(info.bsize);
    if (available - inFlightBytes - incomingBytes < reserve) throw new Error("Not enough free space on the storage disk for this upload");
  }
  inFlightBytes += incomingBytes;
}

/** Test hook: bytes currently reserved by in-flight uploads. */
export function inFlightUploadBytes() {
  return inFlightBytes;
}

/**
 * Streams a body into the object at `key`. The object appears only when the whole stream succeeded;
 * a failed or rejected stream leaves nothing behind. Refuses to replace an existing object.
 */
export async function writeLocalObject(root: string, key: string, body: Readable | Buffer, options: { expectedBytes?: number; env?: Env } = {}) {
  const env = options.env ?? process.env;
  const { target, directory } = await safeDirectoryFor(root, key);
  const incoming = options.expectedBytes ?? (Buffer.isBuffer(body) ? body.length : 0);
  await reserveFreeSpace(directory, incoming, env);
  const temporary = path.join(directory, `${TEMP_PREFIX}${randomBytes(12).toString("hex")}`);
  try {
    // "wx": O_CREAT | O_EXCL, so the temporary name can never be an existing file or symlink.
    const handle = await open(temporary, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | NOFOLLOW, 0o640);
    await pipeline(Buffer.isBuffer(body) ? Readable.from([body]) : body, handle.createWriteStream({ flush: true }));
    try {
      // link() fails with EEXIST instead of replacing, unlike rename().
      await link(temporary, target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new StorageObjectExistsError();
      throw error;
    }
  } finally {
    inFlightBytes -= incoming;
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

/** Deletes the object; deleting a missing object succeeds, like S3. */
export async function removeLocalObject(root: string, key: string) {
  let real: string;
  try {
    real = await existingObjectPath(root, key);
  } catch (error) {
    if (error instanceof StorageObjectNotFoundError) return;
    throw error;
  }
  try {
    await unlink(real);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export interface ByteRange {
  start: number;
  end: number;
}

/** Parses a single-range "Range: bytes=..." header. Returns null for absent or multi-range headers, "invalid" when unsatisfiable. */
export function parseRange(header: string | null | undefined, size: number): ByteRange | null | "invalid" {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const [, rawStart, rawEnd] = match;
  if (!rawStart && !rawEnd) return "invalid";
  if (!rawStart) {
    const suffix = Number(rawEnd);
    if (!Number.isSafeInteger(suffix) || suffix <= 0 || size === 0) return "invalid";
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(rawStart);
  const end = rawEnd ? Math.min(Number(rawEnd), size - 1) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || end < start) return "invalid";
  return { start, end };
}

export interface LocalObjectRead {
  size: number;
  modified: Date;
  /** First bytes of the file, for type detection. */
  head: Buffer;
  stream: (range?: ByteRange) => ReadStream;
  close: () => Promise<void>;
}

/** Opens an object for reading without following a symlink at the last component. */
export async function openLocalObject(root: string, key: string): Promise<LocalObjectRead> {
  const real = await existingObjectPath(root, key);
  const handle = await open(real, fsConstants.O_RDONLY | NOFOLLOW).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT" || error.code === "ELOOP") throw new StorageObjectNotFoundError();
    throw error;
  });
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new StorageObjectNotFoundError();
    const head = Buffer.alloc(Math.min(16, info.size));
    if (head.length) await handle.read(head, 0, head.length, 0);
    let used = false;
    return {
      size: info.size,
      modified: info.mtime,
      head,
      stream(range) {
        if (used) throw new Error("Local object stream already opened");
        used = true;
        return handle.createReadStream({ autoClose: true, start: range?.start ?? 0, end: range?.end, highWaterMark: 256 * 1024 });
      },
      async close() {
        if (!used) await handle.close().catch(() => undefined);
      },
    };
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

const SIGNATURES: Array<[string, (b: Buffer) => boolean]> = [
  ["image/jpeg", (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff],
  ["image/png", (b) => b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))],
  ["image/gif", (b) => ["GIF87a", "GIF89a"].includes(b.subarray(0, 6).toString("latin1"))],
  ["image/webp", (b) => b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP"],
  ["video/webm", (b) => b.length >= 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3],
  ["application/pdf", (b) => b.subarray(0, 5).toString("latin1") === "%PDF-"],
];

/**
 * The type a local object is served as. Disk has no content-type metadata, so it comes from the
 * bytes (an allowlist of media signatures), then the extension for MP4/QuickTime, which share one
 * signature. Anything else is served as a download, never rendered.
 */
export function servedContentType(key: string, head: Buffer): { contentType: string; inline: boolean } {
  // PDFs download: the sandbox CSP on these responses breaks the browser's built-in PDF viewer.
  for (const [type, matches] of SIGNATURES) if (matches(head)) return { contentType: type, inline: type !== "application/pdf" };
  if (head.subarray(4, 8).toString("latin1") === "ftyp") {
    return { contentType: key.toLowerCase().endsWith(".mov") ? "video/quicktime" : "video/mp4", inline: true };
  }
  return { contentType: "application/octet-stream", inline: false };
}

/** Read-write-delete probe used by connection verification; reports free space on the storage disk. */
export async function probeLocalStorage(root: string, env: Env = process.env) {
  const rootReal = await realRoot(root);
  // A directory name that no storage key can produce (keys never start with a dot).
  const directory = path.join(rootReal, ".polynovea-verification");
  await mkdir(directory, { recursive: true, mode: 0o750 });
  const file = path.join(directory, randomBytes(8).toString("hex"));
  const linked = `${file}-link`;
  const body = randomBytes(32);
  try {
    const writer = await open(file, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | NOFOLLOW, 0o640);
    try {
      await writer.writeFile(body);
    } finally {
      await writer.close();
    }
    // Uploads are committed with link(); a mount without hard links (SMB, Azure Files, some Docker
    // bind mounts on Windows) must fail here, not on every upload.
    try {
      await link(file, linked);
    } catch (error) {
      throw new Error(`The storage directory does not support hard links (${(error as NodeJS.ErrnoException).code ?? "error"}); use a local disk such as ext4 or xfs`);
    }
    const reader = await open(linked, fsConstants.O_RDONLY | NOFOLLOW);
    try {
      if (!(await reader.readFile()).equals(body)) throw new Error("Storage read-back did not match the disposable verification file");
    } finally {
      await reader.close();
    }
  } finally {
    await unlink(file).catch(() => undefined);
    await unlink(linked).catch(() => undefined);
  }
  const info = await statfs(rootReal);
  return { root: rootReal, availableBytes: Number(info.bavail) * Number(info.bsize), minFreeBytes: minFreeBytes(env) };
}
