import { NextResponse, type NextRequest } from "next/server";
import { resolveMode, type AppMode } from "@/lib/setup/mode";

/**
 * Route gate for setup mode (lib/setup/mode.ts):
 *
 * - setup: only the wizard (/setup, /api/setup/*), the static files its pages need and /api/health.
 *   Everything else answers 503 with a link to /setup.
 * - running: /setup and /api/setup/* answer 404; everything else passes.
 * - unavailable: everything but /api/health answers 503. Never the wizard.
 *
 * This is the first of two layers. Middleware can be skipped by a framework bug (CVE-2025-29927), so
 * the database pool and assertMode() in the setup route handlers enforce the same rules again.
 */

export const config = {
  runtime: "nodejs",
  // Build output is static and harmless; everything else, including /_next/image, goes through the gate.
  matcher: ["/((?!_next/static/).*)"],
};

export type GateDecision = "pass" | "not-found" | "setup-required" | "unavailable";

const SETUP_PAGE = /^\/setup(?:\/.*)?$/;
const SETUP_API = /^\/api\/setup(?:\/.*)?$/;
const ALWAYS = new Set(["/api/health", "/favicon.ico"]);

export function isSetupPath(pathname: string): boolean {
  return SETUP_PAGE.test(pathname) || SETUP_API.test(pathname);
}

/** What the gate does with one path in one mode. Pure, for tests. */
export function gateDecision(pathname: string, mode: AppMode, options: { dev?: boolean } = {}): GateDecision {
  if (ALWAYS.has(pathname) || pathname.startsWith("/_next/static/")) return "pass";
  // Next's dev server streams code updates to the open setup page here.
  if (options.dev && pathname.startsWith("/_next/webpack-hmr")) return "pass";
  if (mode === "running") return isSetupPath(pathname) ? "not-found" : "pass";
  if (mode === "unavailable") return "unavailable";
  return isSetupPath(pathname) ? "pass" : "setup-required";
}

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * On every wizard page and setup API answer: never sent as a referrer (the address and any query
 * stay on this server), never framed (no clickjacking of the code or owner forms), never cached or
 * indexed.
 */
export const SETUP_HEADERS: Record<string, string> = {
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy": "frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "X-Robots-Tag": "noindex, nofollow",
  "Cache-Control": "no-store",
};

function page(title: string, body: string, status: number) {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${title}</title></head><body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;line-height:1.5"><h1 style="font-size:1.25rem">${title}</h1>${body}</body></html>`;
  return new NextResponse(html, { status, headers: { "Content-Type": "text/html; charset=utf-8", ...SETUP_HEADERS } });
}

export function gateResponse(decision: Exclude<GateDecision, "pass">, pathname: string): NextResponse {
  const api = pathname.startsWith("/api/");
  if (decision === "not-found") {
    return api ? NextResponse.json({ error: "Not found" }, { status: 404, headers: NO_STORE }) : page("Not found", "<p>This page does not exist.</p>", 404);
  }
  if (decision === "setup-required") {
    return api
      ? NextResponse.json({ error: "Setup is not finished", setup: "/setup" }, { status: 503, headers: { ...NO_STORE, "Retry-After": "60" } })
      : page("Setup is not finished", '<p>This CMS has not been set up yet. <a href="/setup">Continue to setup</a>.</p>', 503);
  }
  return api
    ? NextResponse.json({ error: "The CMS is temporarily unavailable" }, { status: 503, headers: { ...NO_STORE, "Retry-After": "30" } })
    : page("Temporarily unavailable", "<p>The CMS cannot reach its database. Try again in a minute; if this persists, the server log says why.</p>", 503);
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const { mode } = await resolveMode();
  const decision = gateDecision(pathname, mode, { dev: process.env.NODE_ENV === "development" });
  if (decision !== "pass") return gateResponse(decision, pathname);
  if (!isSetupPath(pathname)) return NextResponse.next();
  const response = NextResponse.next();
  for (const [name, value] of Object.entries(SETUP_HEADERS)) response.headers.set(name, value);
  return response;
}
