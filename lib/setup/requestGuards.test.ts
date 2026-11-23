import { describe, expect, it, vi } from "vitest";
import {
  SETUP_GUARD_MESSAGE, cleanAddress, guardSetupRequest, hasCodeInQuery, isLoopbackAddress, setupClientAddress, setupOwnOrigin,
  setupRequestProblem, setupTransport, withSetupHeaders,
} from "./requestGuards";

const PROXIED = { POLYNOVEA_TRUSTED_PROXIES: "10.0.0.0/8, 127.0.0.1" };
const DIRECT = {};

/** A request as Next.js hands it over: X-Forwarded-* filled from the socket when absent. */
function req(headers: Record<string, string>, url = "http://internal/api/setup/code", method = "POST") {
  return { headers: new Headers(headers), url, method };
}

const httpsViaProxy = {
  host: "cms.example.com",
  origin: "https://cms.example.com",
  "x-forwarded-for": "203.0.113.9",
  "x-forwarded-proto": "https",
  "x-forwarded-host": "cms.example.com",
  "sec-fetch-site": "same-origin",
};

const tunnel = {
  host: "localhost:3000",
  origin: "http://localhost:3000",
  "x-forwarded-for": "127.0.0.1",
  "x-forwarded-proto": "http",
  "x-forwarded-host": "localhost:3000",
};

describe("client address (trusted-proxy rule)", () => {
  it("walks X-Forwarded-For right to left past trusted proxies", () => {
    expect(setupClientAddress(new Headers({ "x-forwarded-for": "198.51.100.1, 203.0.113.9, 10.1.2.3" }), PROXIED)).toBe("203.0.113.9");
  });

  it("a spoofed left-hand entry cannot choose the client address", () => {
    expect(setupClientAddress(new Headers({ "x-forwarded-for": "127.0.0.1, 203.0.113.9" }), PROXIED)).toBe("203.0.113.9");
  });

  it("when every hop is trusted (a request from the proxy host itself), the first hop is the client", () => {
    expect(setupClientAddress(new Headers({ "x-forwarded-for": "127.0.0.1" }), PROXIED)).toBe("127.0.0.1");
  });

  it("without a proxy list, takes the address Next.js recorded from the socket", () => {
    expect(setupClientAddress(new Headers({ "x-forwarded-for": "::ffff:127.0.0.1" }), DIRECT)).toBe("127.0.0.1");
    expect(setupClientAddress(new Headers({}), DIRECT)).toBeNull();
  });

  it("cleans ports, brackets, zones and IPv4-mapped forms", () => {
    expect(cleanAddress("[::1]:5000")).toBe("::1");
    expect(cleanAddress("203.0.113.9:443")).toBe("203.0.113.9");
    expect(cleanAddress("fe80::1%eth0")).toBe("fe80::1");
    expect(cleanAddress("::FFFF:192.0.2.1")).toBe("192.0.2.1");
    expect(cleanAddress("unknown")).toBeNull();
  });

  it("knows loopback addresses", () => {
    expect(isLoopbackAddress("127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("127.8.9.10")).toBe(true);
    expect(isLoopbackAddress("::1")).toBe(true);
    expect(isLoopbackAddress("10.0.0.1")).toBe(false);
    expect(isLoopbackAddress(null)).toBe(false);
  });
});

describe("transport: HTTPS through a trusted proxy, or loopback", () => {
  it("accepts HTTPS reported by a trusted proxy", () => {
    expect(setupTransport(new Headers(httpsViaProxy), PROXIED)).toBe("https");
  });

  it("ignores X-Forwarded-Proto when no proxy is trusted (anyone could send it)", () => {
    expect(setupTransport(new Headers({ ...httpsViaProxy }), DIRECT)).toBeNull();
  });

  it("uses the nearest proxy's value when several are listed", () => {
    expect(setupTransport(new Headers({ ...httpsViaProxy, "x-forwarded-proto": "https, http" }), PROXIED)).toBeNull();
    expect(setupTransport(new Headers({ ...httpsViaProxy, "x-forwarded-proto": "http, https" }), PROXIED)).toBe("https");
  });

  it("accepts an SSH tunnel: a loopback client asking for a loopback host", () => {
    expect(setupTransport(new Headers(tunnel), DIRECT)).toBe("loopback");
    expect(setupTransport(new Headers(tunnel), PROXIED)).toBe("loopback");
    expect(setupTransport(new Headers({ ...tunnel, host: "[::1]:3000", "x-forwarded-host": "[::1]:3000", "x-forwarded-for": "::1" }), DIRECT)).toBe("loopback");
  });

  it("refuses plain HTTP to a public address", () => {
    expect(setupTransport(new Headers({ host: "203.0.113.50:3000", "x-forwarded-for": "198.51.100.1", "x-forwarded-proto": "http" }), PROXIED)).toBeNull();
  });

  it("refuses a loopback host requested from a remote client, and a public host from loopback", () => {
    expect(setupTransport(new Headers({ ...tunnel, "x-forwarded-for": "198.51.100.1" }), DIRECT)).toBeNull();
    expect(setupTransport(new Headers({ ...tunnel, host: "203.0.113.50:3000", "x-forwarded-host": "203.0.113.50:3000" }), DIRECT)).toBeNull();
  });

  it("behind a proxy, a forged loopback entry in X-Forwarded-For does not count as loopback", () => {
    expect(setupTransport(new Headers({ ...tunnel, "x-forwarded-for": "127.0.0.1, 198.51.100.1" }), PROXIED)).toBeNull();
  });
});

describe("Origin", () => {
  it("own origin follows the trusted proxy's host and scheme", () => {
    expect(setupOwnOrigin(new Headers(httpsViaProxy), PROXIED)).toBe("https://cms.example.com");
    expect(setupOwnOrigin(new Headers(tunnel), DIRECT)).toBe("http://localhost:3000");
  });

  it("passes when Origin matches", () => {
    expect(setupRequestProblem(req(httpsViaProxy), PROXIED)).toBeNull();
    expect(setupRequestProblem(req(tunnel), DIRECT)).toBeNull();
  });

  it("refuses a missing, null or foreign Origin", () => {
    const { origin: _omit, ...noOrigin } = httpsViaProxy;
    expect(setupRequestProblem(req(noOrigin), PROXIED)).toMatch(/Origin/);
    expect(setupRequestProblem(req({ ...httpsViaProxy, origin: "null" }), PROXIED)).toMatch(/Origin/);
    expect(setupRequestProblem(req({ ...httpsViaProxy, origin: "https://evil.example" }), PROXIED)).toMatch(/Origin/);
    expect(setupRequestProblem(req({ ...httpsViaProxy, origin: "http://cms.example.com" }), PROXIED)).toMatch(/Origin/);
  });

  it("refuses a cross-site fetch even if Origin were forged to match", () => {
    expect(setupRequestProblem(req({ ...httpsViaProxy, "sec-fetch-site": "cross-site" }), PROXIED)).toBe("cross-site request");
  });

  it("when POLYNOVEA_PUBLIC_URL is set, Origin must match it too", () => {
    const env = { ...PROXIED, POLYNOVEA_PUBLIC_URL: "https://cms.example.com/" };
    expect(setupRequestProblem(req(httpsViaProxy), env)).toBeNull();
    const other = { ...httpsViaProxy, host: "other.example.com", origin: "https://other.example.com", "x-forwarded-host": "other.example.com" };
    expect(setupRequestProblem(req(other), env)).toBe("Origin does not match POLYNOVEA_PUBLIC_URL");
  });
});

describe("code in the query string", () => {
  it("is detected in any case", () => {
    expect(hasCodeInQuery("/api/setup/code?code=ABC")).toBe(true);
    expect(hasCodeInQuery("/api/setup/code?x=1&CODE=ABC")).toBe(true);
    expect(hasCodeInQuery("/api/setup/code?Code")).toBe(true);
    expect(hasCodeInQuery("/api/setup/code?codex=1")).toBe(false);
    expect(hasCodeInQuery("/api/setup/code")).toBe(false);
  });

  it("refuses the request even when everything else is right", () => {
    expect(setupRequestProblem(req(httpsViaProxy, "https://cms.example.com/api/setup/code?code=ABC"), PROXIED)).toBe("setup code in the query string");
  });
});

describe("method", () => {
  it("only POST passes", () => {
    expect(setupRequestProblem(req(httpsViaProxy, undefined, "GET"), PROXIED)).toBe("not a POST");
  });
});

describe("responses", () => {
  it("adds no-store, no-referrer and frame-ancestors 'none'", () => {
    const response = withSetupHeaders(new Response("ok"));
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("content-security-policy")).toBe("frame-ancestors 'none'");
  });

  it("every guard failure gets the same generic 403; the reason goes only to the log", async () => {
    const warn = vi.fn();
    const failures = [
      req({ ...httpsViaProxy, origin: "https://evil.example" }),
      req(httpsViaProxy, "https://cms.example.com/api/setup/code?code=1"),
      req({ ...httpsViaProxy, "x-forwarded-proto": "http" }),
      req({ ...httpsViaProxy, "sec-fetch-site": "cross-site" }),
    ];
    const bodies = await Promise.all(
      failures.map(async (request) => {
        const response = guardSetupRequest(request, PROXIED, { warn })!;
        expect(response.status).toBe(403);
        expect(response.headers.get("cache-control")).toBe("no-store");
        const body = await response.json();
        return { error: body.error, code: body.code };
      }),
    );
    for (const body of bodies) expect(body).toEqual({ error: SETUP_GUARD_MESSAGE, code: "SETUP_REQUEST_REFUSED" });
    expect(warn).toHaveBeenCalledTimes(failures.length);
  });

  it("returns null when the request may proceed", () => {
    expect(guardSetupRequest(req(httpsViaProxy), PROXIED, { warn: vi.fn() })).toBeNull();
  });
});
