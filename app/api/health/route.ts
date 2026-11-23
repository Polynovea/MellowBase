import { resolveMode } from "@/lib/setup/mode";

// Liveness for load balancers and the upgrade check: 200 in every mode, with the mode as `state`
// ("setup", "running" or "unavailable"). Nothing else, so it is safe to leave public.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const { mode } = await resolveMode();
  return Response.json({ state: mode }, { status: 200, headers: { "Cache-Control": "no-store" } });
}
