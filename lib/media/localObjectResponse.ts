import { Readable } from "node:stream";
import { localStorageRoot, openLocalObject, parseRange, servedContentType, StorageKeyError, StorageObjectNotFoundError } from "@/lib/media/localDiskStorage";

// HTTP response for an object on the local storage disk, shared by the expiring read route and the
// permanent media link route. Files are served only as an allowlisted media type detected from their
// bytes (anything else is a download), with nosniff and a sandboxing CSP, so a stored file can never
// run as a page on the CMS origin.

export function plainResponse(status: number, message: string) {
  return new Response(message, { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" } });
}

export async function localObjectResponse(req: Request, key: string, options: { cacheControl: string; includeBody: boolean }) {
  let object;
  try {
    object = await openLocalObject(localStorageRoot(), key);
  } catch (error) {
    if (error instanceof StorageObjectNotFoundError || error instanceof StorageKeyError) return plainResponse(404, "Not found");
    console.error("[storage] local read failed", error);
    return plainResponse(500, "Could not read the file");
  }

  const { contentType, inline } = servedContentType(key, object.head);
  const headers = new Headers({
    "content-type": contentType,
    "accept-ranges": "bytes",
    "cache-control": options.cacheControl,
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
  if (!options.includeBody || length === 0) {
    await object.close();
    return new Response(null, { status, headers });
  }
  return new Response(Readable.toWeb(object.stream(range ?? undefined)) as ReadableStream<Uint8Array>, { status, headers });
}
