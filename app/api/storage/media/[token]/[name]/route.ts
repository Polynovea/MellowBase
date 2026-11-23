import { NextResponse } from "next/server";
import { localObjectResponse, plainResponse } from "@/lib/media/localObjectResponse";
import { verifyStorageToken } from "@/lib/media/signedStorageUrls";
import { isWorkspaceStorageKey } from "@/lib/media/storageKeys";
import { getStorageProvider } from "@/lib/media/storageProvider";

// Permanent media link: what content stores (image fields, rich text), so published pages keep working
// after any signed read URL would have expired. The token is HMAC-signed over one object of one
// workspace's storage connection and has no expiry; it stops working when the object is deleted or
// its signing key leaves the key ring.
//
// - Local disk: served here directly (no database lookup), cacheable, since objects are never
//   overwritten under the same key.
// - Other providers (private S3, Azure, Supabase): a short-lived redirect to a freshly signed read URL.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const REDIRECT_CACHE_SECONDS = 300;

async function serve(req: Request, params: Promise<{ token: string; name: string }>, includeBody: boolean) {
  const { token } = await params;
  const verified = verifyStorageToken(token, "media");
  if (!verified.ok) return plainResponse(403, "This link is invalid");
  const { p: providerKey, w: workspaceId, k: key, d: servedFrom } = verified.payload;
  if (!isWorkspaceStorageKey(workspaceId, key)) return plainResponse(404, "Not found");
  if (servedFrom === "local") return localObjectResponse(req, key, { cacheControl: "public, max-age=86400", includeBody });
  try {
    const provider = await getStorageProvider({ workspaceId, storageProviderKey: providerKey });
    const target = await provider.resolveReadUrl(key);
    // Cached for less time than the signed URL it points at lives.
    return NextResponse.redirect(new URL(target, req.url), { status: 302, headers: { "cache-control": `private, max-age=${REDIRECT_CACHE_SECONDS}`, "referrer-policy": "no-referrer" } });
  } catch (error) {
    console.error("[storage] media link resolution failed", error);
    return plainResponse(404, "Not found");
  }
}

export function GET(req: Request, { params }: { params: Promise<{ token: string; name: string }> }) {
  return serve(req, params, true);
}

export function HEAD(req: Request, { params }: { params: Promise<{ token: string; name: string }> }) {
  return serve(req, params, false);
}
