import { resolveMode } from "@/lib/setup/mode";

// Liveness for load balancers and the upgrade check: 200 in every mode, with the mode as `state`
// ("setup", "running" or "unavailable") and the release this server runs as `release` (the image's
// POLYNOVEA_RELEASE_ID, set at build time; null outside a built image). The upgrade check compares
// `release` with the release it just started. Nothing else, so it is safe to leave public.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const RELEASE_ID = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,127}$/;

function releaseId(): string | null {
  const value = process.env.POLYNOVEA_RELEASE_ID?.trim() ?? "";
  return RELEASE_ID.test(value) ? value : null;
}

export async function GET() {
  const { mode } = await resolveMode();
  return Response.json({ state: mode, release: releaseId() }, { status: 200, headers: { "Cache-Control": "no-store" } });
}
