import { localObjectResponse, plainResponse } from "@/lib/media/localObjectResponse";
import { verifyStorageToken } from "@/lib/media/signedStorageUrls";

// Expiring signed read URL for media on the server's own disk (storage.local connections), used for
// admin previews and API read URLs. The token carries the storage key and expiry, HMAC-signed with the
// server's storage signing key; the trailing file name is cosmetic. Content stores the permanent
// /api/storage/media link instead.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function serve(req: Request, params: Promise<{ token: string; name: string }>, includeBody: boolean) {
  const { token } = await params;
  const verified = verifyStorageToken(token, "read");
  if (!verified.ok) return plainResponse(403, "This link is invalid or has expired");
  const remaining = Math.max(0, verified.payload.e - Math.floor(Date.now() / 1000));
  return localObjectResponse(req, verified.payload.k, { cacheControl: `private, max-age=${remaining}`, includeBody });
}

export function GET(req: Request, { params }: { params: Promise<{ token: string; name: string }> }) {
  return serve(req, params, true);
}

export function HEAD(req: Request, { params }: { params: Promise<{ token: string; name: string }> }) {
  return serve(req, params, false);
}
