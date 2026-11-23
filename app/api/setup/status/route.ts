import { assertMode, ModeError } from "@/lib/setup/mode";

// The wizard's view of where setup stands. Setup mode only: on a finished install it is 404, like
// every /setup route (the middleware answers first; this is the second layer).
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  try {
    const state = await assertMode("setup");
    return Response.json(
      { mode: state.mode, databaseConfigured: state.databaseSource !== null, databaseReady: state.databaseReady },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    if (error instanceof ModeError) return error.toResponse();
    throw error;
  }
}
