import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { revalidateWebsiteBlog } from "./revalidate";

describe("revalidateWebsiteBlog", () => {
  beforeEach(() => {
    vi.stubEnv("WEBSITE_URL", "https://site.example.com");
    vi.stubEnv("WEBSITE_REVALIDATE_SECRET", "s3cret");
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it("skips when the website is not configured", async () => {
    vi.stubEnv("WEBSITE_URL", "");
    expect(await revalidateWebsiteBlog("a")).toEqual({ status: "skipped", reason: "not_configured" });
  });

  it("posts with a timeout signal and reports success", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await revalidateWebsiteBlog("hello")).toEqual({ status: "ok" });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect(String(url)).toBe("https://site.example.com/api/revalidate");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("reports an HTTP failure instead of swallowing it", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 503 })));
    expect(await revalidateWebsiteBlog("x")).toEqual({ status: "failed", error: "Website revalidation returned HTTP 503" });
    expect(console.warn).toHaveBeenCalled();
  });

  it("reports a timeout", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw Object.assign(new Error("timeout"), { name: "TimeoutError" }); }));
    const outcome = await revalidateWebsiteBlog("x");
    expect(outcome.status).toBe("failed");
    expect(outcome.status === "failed" && outcome.error).toMatch(/timed out/);
  });
});
