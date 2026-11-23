import { Readable } from "node:stream";
import { localStorageRoot, openLocalObject, parseRange, servedContentType, StorageKeyError, StorageObjectNotFoundError } from "@/lib/media/localDiskStorage";
import { verifyStorageToken } from "@/lib/media/signedStorageUrls";

// Signed, expiring read URL for media on the server's own disk (storage.local connections). The token
// carries the storage key and expiry, HMAC-signed with the server's storage signing key; the trailing
// file name is cosmetic. No session is needed, so pages on the public site can embed the URL.
//
// Files are served only as an allowlisted media type detected from their bytes (anything else is a
// download), with nosniff and a sandboxing CSP, so a stored file can never run as a page on this origin.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function denied(status: number, message: string) {
  return new Response(message, { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" } });
}

async function serve(req: Request, params: Promise<{ token: string; name: string }>, includeBody: boolean) {
  const { token } = await params;
  const verified = verifyStorageToken(token, "read");
  if (!verified.ok) return denied(403, "This link is invalid or has expired");
  const { k: key, e: expires } = verified.payload;

  let object;
  try {
    object = await openLocalObject(localStorageRoot(), key);
  } catch (error) {
    if (error instanceof StorageObjectNotFoundError || error instanceof StorageKeyError) return denied(404, "Not found");
    console.error("[storage] local read failed", error);
    return denied(500, "Could not read the file");
  }

  const { contentType, inline } = servedContentType(key, object.head);
  const remaining = Math.max(0, expires - Math.floor(Date.now() / 1000));
  const headers = new Headers({
    "content-type": contentType,
    "accept-ranges": "bytes",
    "cache-control": `private, max-age=${remaining}`,
    "last-modified": object.modified.toUTCString(),
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'; sandbox",
    "cross-origin-resource-policy": "cross-origin",
    "content-disposition": inline ? "inline" : "attachment",
  });

  const range = parseRange(req.headers.get("range"), object.size);
  if (range === "invalid") {
    await object.close();
    headers.set("content-range", `bytes */${object.size}`);
    return new Response(null, { status: 416, headers });
  }
  const status = range ? 206 : 200;
  const length = range ? range.end - range.start + 1 : object.size;
  headers.set("content-length", String(length));
  if (range) headers.set("content-range", `bytes ${range.start}-${range.end}/${object.size}`);
  if (!includeBody || length === 0) {
    await object.close();
    return new Response(null, { status, headers });
  }
  const stream = object.stream(range ?? undefined);
  return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, { status, headers });
}

export function GET(req: Request, { params }: { params: Promise<{ token: string; name: string }> }) {
  return serve(req, params, true);
}

export function HEAD(req: Request, { params }: { params: Promise<{ token: string; name: string }> }) {
  return serve(req, params, false);
}
