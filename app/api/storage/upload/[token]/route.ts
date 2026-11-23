import { pipeline, Readable } from "node:stream";
import type { ReadableStream as NodeWebReadableStream } from "node:stream/web";
import { NextResponse } from "next/server";
import { clientErrorMessage } from "@/lib/http/clientError";
import { AzureBlobExistsError } from "@/lib/media/azureBlobStorage";
import { StorageKeyError, StorageObjectExistsError } from "@/lib/media/localDiskStorage";
import { verifyStorageToken } from "@/lib/media/signedStorageUrls";
import { isWorkspaceStorageKey } from "@/lib/media/storageKeys";
import { getStorageProvider } from "@/lib/media/storageProvider";
import { enforceUploadRules, mediaTypeOf, UploadRejectedError } from "@/lib/media/uploadStream";

// Signed upload URL for adapters without their own size-binding signatures (local disk, Azure Blob).
// The URL is the capability: /api/upload/sas mints it for an authenticated user with media.upload,
// for one key, one content type and one exact size, valid for 15 minutes. Like an S3 presigned PUT,
// a body of another type or size is refused; unlike one, the bytes must also start with the declared
// media type's signature, and an existing object is never replaced (so a token works once).

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ts = () => new Date().toISOString();
const fail = (status: number, error: string) => NextResponse.json({ success: false, data: null, error, timestamp: ts() }, { status, headers: { "cache-control": "no-store" } });

export async function PUT(req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const verified = verifyStorageToken(token, "write");
  if (!verified.ok) return fail(403, "Upload URL is invalid or has expired");
  const signed = verified.payload;
  if (!isWorkspaceStorageKey(signed.w, signed.k)) return fail(403, "Upload URL is invalid or has expired");
  if (mediaTypeOf(req.headers.get("content-type")) !== signed.t) return fail(415, "Content-Type must match the type this upload URL was signed for");
  const declared = req.headers.get("content-length");
  if (declared !== null && declared.trim() !== String(signed.n)) return fail(413, "Content-Length must match the size this upload URL was signed for");
  if (!req.body) return fail(400, "Upload body is empty");

  try {
    const provider = await getStorageProvider({ workspaceId: signed.w, storageProviderKey: signed.p });
    if (provider.key !== signed.p || !provider.writeStream) return fail(409, "This storage connection does not accept uploads through the app");
    const limited = enforceUploadRules(signed.n, signed.t);
    const source = Readable.fromWeb(req.body as unknown as NodeWebReadableStream<Uint8Array>);
    // pipeline destroys the request stream too when the limiter refuses the body.
    pipeline(source, limited, () => undefined);
    await provider.writeStream({ key: signed.k, contentType: signed.t, contentLength: signed.n, body: limited });
    return NextResponse.json({ success: true, data: { key: signed.k }, error: null, timestamp: ts() }, { status: 201, headers: { "cache-control": "no-store" } });
  } catch (error) {
    if (error instanceof UploadRejectedError) return fail(error.status, error.message);
    if (error instanceof StorageObjectExistsError || error instanceof AzureBlobExistsError) return fail(409, "This upload URL has already been used");
    if (error instanceof StorageKeyError) return fail(400, error.message);
    return fail(500, clientErrorMessage(error, "Upload failed"));
  }
}
