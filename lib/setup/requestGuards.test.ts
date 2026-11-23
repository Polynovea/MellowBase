import { describe, expect, it, vi } from "vitest";
import { peerStampEntryForTests, type PeerInfo } from "./peerStamp";
import {
  SETUP_GUARD_MESSAGE, cleanAddress, guardSetupRequest, hasCodeInQuery, isLoopbackAddress, setupClientAddress, setupOwnOrigin,
  setupRequestProblem, setupTransport, withSetupHeaders,
} from "./requestGuards";

const PROXIED = { POLYNOVEA_TRUSTED_PROXIES: "10.0.0.0/8, 127.0.0.1" };
const DIRECT = {};

/**
 * Headers as a route handler sees them: the client's headers, then what Next.js adds with `??=`
 * (X-Forwarded-For/-Proto/-Host from the socket when absent), plus the boot-time peer stamp.
 */
function seen(client: Record<string, string>, conn: Partial<PeerInfo> & { peer: string; bound?: string }): Headers {
  const forwarded = ["forwarded", "x-forwarded-for", "x-forwarded-proto", "x-forwarded-host", "x-forwarded-port", "x-real-ip"].some((h) => h in client);
  const info: PeerInfo = { peer: conn.peer, bound: conn.bound ?? "0.0.0.0", tls: conn.tls ?? false, forwarded: conn.forwarded ?? forwarded };
  const headers = new Headers(client);
  if (!headers.has("x-forwarded-for")) headers.set("x-forwarded-for", conn.peer);
  if (!headers.has("x-forwarded-proto")) headers.set("x-forwarded-proto", info.tls ? "https" : "http");
  if (!headers.has("x-forwarded-host") && headers.has("host")) headers.set("x-forwarded-host", headers.get("host")!);
  headers.set(...peerStampEntryForTests(info));
  return headers;
}

function req(headers: Headers, url = "http://internal/api/setup/code", method = "POST") {
  return { headers, url, method };
}

/** A browser behind a reverse proxy at 10.0.0.2 that terminates HTTPS. */
const viaProxy = () =>
  seen(
    {
      host: "cms.example.com",
      origin: "https://cms.example.com",
      "x-forwarded-for": "203.0.113.9",
      "x-forwarded-proto": "https",
      "x-forwarded-host": "cms.example.com",
      "sec-fetch-site": "same-origin",
    },
    { peer: "10.0.0.2" },
  );

/** A browser through `ssh -L 3000:localhost:3000` to a server bound to 127.0.0.1. */
const tunnel = (client: Record<string, string> = {}, conn: { peer?: string; bound?: string; tls?: boolean; forwarded?: boolean } = {}) =>
  seen({ host: "localhost:3000", origin: "http://localhost:3000", ...client }, { peer: "127.0.0.1", bound: "127.0.0.1", ...conn });

describe("client address", () => {
  it("behind a trusted proxy, walks X-Forwarded-For right to left past the proxies", () => {
    const headers = seen({ "x-forwarded-for": "198.51.100.1, 203.0.113.9, 10.1.2.3" }, { peer: "10.0.0.2" });
    expect(setupClientAddress(headers, PROXIED)).toBe("203.0.113.9");
  });

  it("behind a trusted proxy, a spoofed left-hand entry cannot choose the client address", () => {
    expect(setupClientAddress(seen({ "x-forwarded-for": "127.0.0.1, 203.0.113.9" }, { peer: "10.0.0.2" }), PROXIED)).toBe("203.0.113.9");
  });

  it("from a peer that is not a trusted proxy, X-Forwarded-For is ignored: the client is the socket's peer", () => {
    const spoofed = seen({ "x-forwarded-for": "192.0.2.77" }, { peer: "198.51.100.5" });
    expect(setupClientAddress(spoofed, DIRECT)).toBe("198.51.100.5");
    expect(setupClientAddress(spoofed, PROXIED)).toBe("198.51.100.5");
  });

  it("rotating X-Forwarded-For values from one peer all resolve to that one peer", () => {
    const addresses = new Set(
      Array.from({ length: 20 }, (_, i) => setupClientAddress(seen({ "x-forwarded-for": `192.0.2.${i}` }, { peer: "198.51.100.5" }), DIRECT)),
    );
    expect([...addresses]).toEqual(["198.51.100.5"]);
  });

  it("without the peer stamp, nothing is known (fail closed)", () => {
    expect(setupClientAddress(new Headers({ "x-forwarded-for": "203.0.113.9" }), PROXIED)).toBeNull();
  });

  it("a forged stamp header with a guessed name is not read", () => {
    const headers = new Headers({ "x-polynovea-peer-0000": JSON.stringify({ peer: "127.0.0.1", bound: "127.0.0.1", tls: false, forwarded: false }) });
    expect(setupClientAddress(headers, DIRECT)).toBeNull();
    expect(setupTransport(headers, DIRECT)).toBeNull();
  });

  it("cleans ports, brackets, zones and IPv4-mapped forms", () => {
    expect(cleanAddress("[::1]:5000")).toBe("::1");
    expect(cleanAddress("203.0.113.9:443")).toBe("203.0.113.9");
    expect(cleanAddress("fe80::1%eth0")).toBe("fe80::1");
    expect(cleanAddress("::FFFF:192.0.2.1")).toBe("192.0.2.1");
    expect(cleanAddress("unknown")).toBeNull();
  });

  it("knows loopback addresses, including the IPv4-mapped form a socket reports", () => {
    expect(isLoopbackAddress("127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("127.8.9.10")).toBe(true);
    expect(isLoopbackAddress("::1")).toBe(true);
    expect(isLoopbackAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("0.0.0.0")).toBe(false);
    expect(isLoopbackAddress("::")).toBe(false);
    expect(isLoopbackAddress(null)).toBe(false);
  });
});

describe("transport: HTTPS", () => {
  it("is believed from a trusted proxy", () => {
    expect(setupTransport(viaProxy(), PROXIED)).toBe("https");
  });

  it("is not believed from anyone else, even with the right header", () => {
    expect(setupTransport(viaProxy(), DIRECT)).toBeNull();
    expect(setupTransport(seen({ host: "cms.example.com", "x-forwarded-proto": "https" }, { peer: "198.51.100.5" }), PROXIED)).toBeNull();
  });

  it("uses the nearest proxy's value when several are listed", () => {
    const base = { host: "cms.example.com", "x-forwarded-for": "203.0.113.9" };
    expect(setupTransport(seen({ ...base, "x-forwarded-proto": "https, http" }, { peer: "10.0.0.2" }), PROXIED)).toBeNull();
    expect(setupTransport(seen({ ...base, "x-forwarded-proto": "http, https" }, { peer: "10.0.0.2" }), PROXIED)).toBe("https");
  });

  it("is true when the socket itself is TLS", () => {
    expect(setupTransport(seen({ host: "cms.example.com" }, { peer: "198.51.100.5", tls: true }), DIRECT)).toBe("https");
  });
});

describe("transport: SSH tunnel (plain HTTP on loopback)", () => {
  it("is accepted from a loopback peer, to a loopback-only server, with no forwarding headers", () => {
    expect(setupTransport(tunnel(), DIRECT)).toBe("loopback");
    expect(setupTransport(tunnel({ host: "[::1]:3000" }, { peer: "::1", bound: "::1" }), DIRECT)).toBe("loopback");
    expect(setupTransport(tunnel({}, { peer: "::ffff:127.0.0.1" }), DIRECT)).toBe("loopback");
  });

  it("is refused when the server listens on every interface (0.0.0.0 or ::)", () => {
    expect(setupTransport(tunnel({}, { bound: "0.0.0.0" }), DIRECT)).toBeNull();
    expect(setupTransport(tunnel({}, { bound: "::" }), DIRECT)).toBeNull();
  });

  it("refuses a spoofed loopback: X-Forwarded-For: 127.0.0.1 and Host: localhost from a remote peer", () => {
    const spoof = seen({ host: "localhost:3000", origin: "http://localhost:3000", "x-forwarded-for": "127.0.0.1" }, { peer: "198.51.100.5", bound: "0.0.0.0" });
    expect(setupTransport(spoof, DIRECT)).toBeNull();
    expect(setupTransport(spoof, PROXIED)).toBeNull();
    expect(setupClientAddress(spoof, DIRECT)).toBe("198.51.100.5");
  });

  it("refuses a local proxy relaying someone else (forwarding headers present)", () => {
    expect(setupTransport(tunnel({ "x-forwarded-for": "198.51.100.1" }), DIRECT)).toBeNull();
    expect(setupTransport(tunnel({ "x-forwarded-for": "127.0.0.1" }), DIRECT)).toBeNull();
    expect(setupTransport(tunnel({ forwarded: "for=127.0.0.1" }), PROXIED)).toBeNull();
  });

  it("refuses a public host name even on a real loopback connection (DNS rebinding)", () => {
    expect(setupTransport(tunnel({ host: "evil.example:3000" }), DIRECT)).toBeNull();
  });

  it("refuses without the peer stamp", () => {
    expect(setupTransport(new Headers({ host: "localhost:3000", "x-forwarded-for": "127.0.0.1" }), DIRECT)).toBeNull();
  });
});

describe("Origin", () => {
  it("own origin follows the trusted proxy's host and scheme, else Host and http", () => {
    expect(setupOwnOrigin(viaProxy(), PROXIED)).toBe("https://cms.example.com");
    expect(setupOwnOrigin(tunnel(), DIRECT)).toBe("http://localhost:3000");
  });

  it("X-Forwarded-Host from an untrusted peer is ignored", () => {
    const headers = seen({ host: "localhost:3000", "x-forwarded-host": "cms.example.com" }, { peer: "127.0.0.1", bound: "127.0.0.1" });
    expect(setupOwnOrigin(headers, DIRECT)).toBe("http://localhost:3000");
  });

  it("passes when Origin matches", () => {
    expect(setupRequestProblem(req(viaProxy()), PROXIED)).toBeNull();
    expect(setupRequestProblem(req(tunnel()), DIRECT)).toBeNull();
  });

  it("refuses a missing, null or foreign Origin", () => {
    const noOrigin = viaProxy();
    noOrigin.delete("origin");
    expect(setupRequestProblem(req(noOrigin), PROXIED)).toMatch(/Origin/);
    for (const origin of ["null", "https://evil.example", "http://cms.example.com"]) {
      const headers = viaProxy();
      headers.set("origin", origin);
      expect(setupRequestProblem(req(headers), PROXIED)).toMatch(/Origin/);
    }
  });

  it("refuses a cross-site fetch even if Origin were forged to match", () => {
    const headers = viaProxy();
    headers.set("sec-fetch-site", "cross-site");
    expect(setupRequestProblem(req(headers), PROXIED)).toBe("cross-site request");
  });

  it("when POLYNOVEA_PUBLIC_URL is set, Origin must match it too", () => {
    const env = { ...PROXIED, POLYNOVEA_PUBLIC_URL: "https://cms.example.com/" };
    expect(setupRequestProblem(req(viaProxy()), env)).toBeNull();
    const other = seen(
      { host: "other.example.com", origin: "https://other.example.com", "x-forwarded-for": "203.0.113.9", "x-forwarded-proto": "https", "x-forwarded-host": "other.example.com" },
      { peer: "10.0.0.2" },
    );
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
    expect(setupRequestProblem(req(viaProxy(), "https://cms.example.com/api/setup/code?code=ABC"), PROXIED)).toBe("setup code in the query string");
  });
});

describe("method and stamp", () => {
  it("only POST passes", () => {
    expect(setupRequestProblem(req(viaProxy(), undefined, "GET"), PROXIED)).toBe("not a POST");
  });

  it("a request without the peer stamp is refused with a reason that says why", () => {
    const headers = new Headers({ host: "localhost:3000", origin: "http://localhost:3000" });
    expect(setupRequestProblem(req(headers), DIRECT)).toMatch(/peer stamp/);
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
    const foreign = viaProxy();
    foreign.set("origin", "https://evil.example");
    const crossSite = viaProxy();
    crossSite.set("sec-fetch-site", "cross-site");
    const failures = [
      req(foreign),
      req(viaProxy(), "https://cms.example.com/api/setup/code?code=1"),
      req(viaProxy()), // HTTPS claimed, but no proxy is trusted in DIRECT
      req(crossSite),
    ];
    const bodies = await Promise.all(
      failures.map(async (request, i) => {
        const response = guardSetupRequest(request, i === 2 ? DIRECT : PROXIED, { warn })!;
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
    expect(guardSetupRequest(req(viaProxy()), PROXIED, { warn: vi.fn() })).toBeNull();
  });
});
