import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { LookupAddress } from "node:dns";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { BlockedDestinationError, createGuardedLookup, guardedFetch, isBlockedAddress } from "./guardedNetwork";

const fakeDns = (addresses: string[]) => (_host: string, cb: (e: NodeJS.ErrnoException | null, a: LookupAddress[]) => void) =>
  cb(null, addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 })));

function runLookup(lookup: ReturnType<typeof createGuardedLookup>, all: boolean) {
  return new Promise<{ error: Error | null; address: unknown; family?: number }>((resolve) =>
    lookup("example.test", { all }, (error, address, family) => resolve({ error, address, family })));
}

describe("isBlockedAddress", () => {
  it.each(["127.0.0.1", "127.8.8.8", "10.0.0.1", "172.16.5.5", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1",
    "::1", "::", "fd12::1", "fe80::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1", "::127.0.0.1", "64:ff9b::a00:1", "[::1]", "not-an-ip"])(
    "blocks %s", (address) => expect(isBlockedAddress(address)).toBe(true));

  it.each(["93.184.216.34", "1.1.1.1", "2606:4700:4700::1111", "::ffff:8.8.8.8"])(
    "allows %s", (address) => expect(isBlockedAddress(address)).toBe(false));
});

describe("createGuardedLookup", () => {
  it("returns only validated public addresses to the socket", async () => {
    const result = await runLookup(createGuardedLookup({ resolve: fakeDns(["93.184.216.34"]) }), false);
    expect(result).toEqual({ error: null, address: "93.184.216.34", family: 4 });
  });

  it("returns the full validated list when the socket asks for all", async () => {
    const result = await runLookup(createGuardedLookup({ resolve: fakeDns(["93.184.216.34", "2606:4700::1"]) }), true);
    expect(result.error).toBeNull();
    expect(result.address).toHaveLength(2);
  });

  it("refuses when any answer is private (the rebinding case)", async () => {
    const result = await runLookup(createGuardedLookup({ resolve: fakeDns(["93.184.216.34", "10.0.0.5"]) }), true);
    expect(result.error).toBeInstanceOf(BlockedDestinationError);
  });

  it("allows private answers only when explicitly permitted (local environments)", async () => {
    const result = await runLookup(createGuardedLookup({ allowPrivate: true, resolve: fakeDns(["127.0.0.1"]) }), false);
    expect(result.error).toBeNull();
  });
});

describe("guardedFetch against a real socket", () => {
  let server: Server;
  let port = 0;
  beforeAll(async () => {
    server = createServer((_req, res) => res.end("internal"));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it("blocks at connect time when a hostname resolves to loopback", async () => {
    // "localhost." skips the literal check, so only the connect-time lookup can stop it.
    const error = await guardedFetch(`http://localhost.:${port}/`).then(() => null, (e: Error & { cause?: unknown }) => e);
    expect(error?.cause).toBeInstanceOf(BlockedDestinationError);
  });

  it("connects through the guarded dispatcher when private destinations are allowed", async () => {
    const response = await guardedFetch(`http://127.0.0.1:${port}/`, {}, { allowPrivate: true });
    expect(await response.text()).toBe("internal");
  });
});

describe("guardedFetch", () => {
  it.each(["https://127.0.0.1/", "https://[::1]/", "https://169.254.169.254/latest", "https://localhost/", "http://[::ffff:127.0.0.1]/"])(
    "refuses the literal destination %s before connecting", async (url) => {
      await expect(guardedFetch(url)).rejects.toBeInstanceOf(BlockedDestinationError);
    });
});
