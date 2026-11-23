import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The wrapper runs in the browser; give it the little of `window` it uses.
const getSession = vi.fn();
vi.mock("@/lib/auth/supabaseProvider", () => ({ getSupabaseBrowserIdentityProvider: () => ({ getSession }) }));

type Call = { url: string; method: string; headers: Headers };

function fakeWindow(responses: Response[]) {
  const calls: Call[] = [];
  const nativeFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof Request ? input.url : String(input);
    const headers = new Headers(input instanceof Request ? input.headers : init?.headers);
    calls.push({ url, method: (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase(), headers });
    if (url.startsWith("/api/auth/csrf")) return Response.json({ data: { token: "csrf-1" } });
    return responses.shift() ?? Response.json({ success: true });
  });
  const location = { origin: "https://cms.example.test", pathname: "/admin/developer", assign: vi.fn() };
  (globalThis as unknown as { window: unknown }).window = { fetch: nativeFetch, location };
  return { calls, location };
}

const stepUpRequired = () => Response.json({ success: false, code: "STEP_UP_REQUIRED" }, { status: 403 });

async function load(provider: "supabase" | "builtin") {
  vi.resetModules();
  process.env.NEXT_PUBLIC_AUTH_PROVIDER = provider;
  return import("@/lib/auth/adminFetch");
}

beforeEach(() => getSession.mockReset());
afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
  delete process.env.NEXT_PUBLIC_AUTH_PROVIDER;
});

describe("admin fetch wrapper", () => {
  it("Supabase: asks for step-up, then retries with the new session's token, not the page's stale one", async () => {
    const { calls } = fakeWindow([stepUpRequired(), Response.json({ success: true })]);
    const { installAdminFetch, setStepUpHandler } = await load("supabase");
    getSession.mockResolvedValue({ session: { accessToken: "fresh-token" } });
    const handler = vi.fn().mockResolvedValue(true);
    setStepUpHandler(handler);
    installAdminFetch();
    const fetchFn = (globalThis as unknown as { window: { fetch: typeof fetch } }).window.fetch;
    const response = await fetchFn("/api/developer/tokens", { method: "POST", headers: { Authorization: "Bearer stale-token" }, body: "{}" });
    expect(response.status).toBe(200);
    expect(handler).toHaveBeenCalledOnce();
    expect(calls.map((c) => c.headers.get("authorization"))).toEqual(["Bearer stale-token", "Bearer fresh-token"]);
  });

  it("Supabase: a cancelled step-up returns the 403 to the page", async () => {
    fakeWindow([stepUpRequired()]);
    const { installAdminFetch, setStepUpHandler } = await load("supabase");
    getSession.mockResolvedValue({ session: { accessToken: "t" } });
    setStepUpHandler(vi.fn().mockResolvedValue(false));
    installAdminFetch();
    const fetchFn = (globalThis as unknown as { window: { fetch: typeof fetch } }).window.fetch;
    expect((await fetchFn("/api/entries/export?modelId=m")).status).toBe(403);
  });

  it("built-in: strips the session marker, adds the CSRF token on writes, and retries after step-up", async () => {
    const { calls } = fakeWindow([stepUpRequired(), Response.json({ success: true })]);
    const { installAdminFetch, setStepUpHandler } = await load("builtin");
    setStepUpHandler(vi.fn().mockResolvedValue(true));
    installAdminFetch();
    const fetchFn = (globalThis as unknown as { window: { fetch: typeof fetch } }).window.fetch;
    const response = await fetchFn("/api/admin/users/1", { method: "PATCH", headers: { Authorization: "Bearer builtin-session" }, body: "{}" });
    expect(response.status).toBe(200);
    const writes = calls.filter((c) => !c.url.startsWith("/api/auth/"));
    expect(writes).toHaveLength(2);
    for (const call of writes) {
      expect(call.headers.get("authorization")).toBeNull();
      expect(call.headers.get("x-polynovea-csrf")).toBe("csrf-1");
    }
  });
});
