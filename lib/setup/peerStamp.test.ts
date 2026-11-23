import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { installPeerStamp, readPeerInfo, stampRequest, uninstallPeerStampForTests } from "./peerStamp";

afterEach(() => uninstallPeerStampForTests());

/** Starts a real HTTP server with the stamp installed and returns what the handler saw. */
async function roundTrip(host: string, headers: Record<string, string>): Promise<{ seen: Headers; port: number }> {
  installPeerStamp();
  let seen = new Headers();
  const server = http.createServer((req, res) => {
    seen = new Headers(Object.entries(req.headers).map(([k, v]): [string, string] => [k, Array.isArray(v) ? v.join(", ") : String(v)]));
    res.end("ok");
  });
  await new Promise<void>((resolve) => server.listen(0, host, resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    await new Promise<void>((resolve, reject) => {
      const request = http.request({ host, port, path: "/setup", headers }, (res) => {
        res.resume();
        res.on("end", () => resolve());
      });
      request.on("error", reject);
      request.end();
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  return { seen, port };
}

describe("peer stamp on a real server", () => {
  it("records the real peer and bind address, whatever X-Forwarded-For claims", async () => {
    const { seen } = await roundTrip("127.0.0.1", { "x-forwarded-for": "203.0.113.9", "x-forwarded-proto": "https" });
    expect(readPeerInfo(seen)).toEqual({ peer: "127.0.0.1", bound: "127.0.0.1", tls: false, forwarded: true });
  });

  it("marks a request without forwarding headers as direct", async () => {
    const { seen } = await roundTrip("127.0.0.1", {});
    expect(readPeerInfo(seen)?.forwarded).toBe(false);
  });

  it("removes a client's attempt to send a stamp header", async () => {
    const { seen } = await roundTrip("127.0.0.1", { "x-polynovea-peer-deadbeef": '{"peer":"10.0.0.2"}' });
    expect(seen.has("x-polynovea-peer-deadbeef")).toBe(false);
    expect(readPeerInfo(seen)?.peer).toBe("127.0.0.1");
  });

  it("is absent when the hook is not installed (guards then fail closed)", async () => {
    let seen = new Headers();
    const server = http.createServer((req, res) => {
      seen = new Headers(Object.entries(req.headers).map(([k, v]): [string, string] => [k, String(v)]));
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    await new Promise<void>((resolve) => http.get({ host: "127.0.0.1", port }, (res) => { res.resume(); res.on("end", resolve); }));
    await new Promise<void>((resolve) => server.close(() => resolve()));
    expect(readPeerInfo(seen)).toBeNull();
  });
});

describe("stampRequest", () => {
  it("reports an every-interface bind as such", () => {
    const request = { headers: {} as Record<string, string>, socket: { remoteAddress: "198.51.100.5" } as never };
    stampRequest(request, { address: () => ({ address: "0.0.0.0", family: "IPv4", port: 3000 }) });
    expect(readPeerInfo(new Headers(request.headers))).toEqual({ peer: "198.51.100.5", bound: "0.0.0.0", tls: false, forwarded: false });
  });

  it("notes the socket's own TLS", () => {
    const request = { headers: {} as Record<string, string>, socket: { remoteAddress: "198.51.100.5", encrypted: true } as never };
    stampRequest(request, null);
    expect(readPeerInfo(new Headers(request.headers))?.tls).toBe(true);
  });
});
