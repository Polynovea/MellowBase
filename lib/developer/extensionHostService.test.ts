import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/admin/serviceRole", () => ({ createServiceRoleClient: vi.fn() }));
vi.mock("@/lib/platform/audit", () => ({ logPlatformEvent: vi.fn(async () => undefined) }));
vi.mock("@/lib/developer/extensionGovernanceService", () => ({
  getActiveExtensionPrivileges: vi.fn(async () => ({
    extension_manifests: {
      extension_key: "cert.host",
      manifest_json: { networkRequirements: [{ origin: "https://api.example.com", methods: ["GET"] }] },
    },
    granted_network_json: ["https://api.example.com"],
    granted_permissions: [],
  })),
}));

import { extensionFetch } from "./extensionHostService";

const base = { workspaceId: "w", installationId: "i", actorId: "a", method: "GET" };
const resolvesTo = (address: string) => async () => [{ address, family: address.includes(":") ? 6 : 4 }];

describe("extensionFetch SSRF guard", () => {
  const fetchMock = vi.fn(async () => new Response("ok", { status: 200 }));
  beforeEach(() => { fetchMock.mockClear(); vi.stubGlobal("fetch", fetchMock); });
  afterEach(() => vi.unstubAllGlobals());

  it("brokers a granted origin that resolves to a public address", async () => {
    const result = await extensionFetch({ ...base, url: "https://api.example.com/v1/records?x=1", lookup: resolvesTo("93.184.216.34") });
    expect(result.status).toBe(200);
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toBe("https://api.example.com/v1/records?x=1");
  });

  it.each(["https://api.example.com//evil.example/x", "https://api.example.com//169.254.169.254/latest", "https://api.example.com/..//evil.example/"])(
    "keeps a protocol-relative-looking path on the granted host (%s)",
    async (url) => {
      await extensionFetch({ ...base, url, lookup: resolvesTo("93.184.216.34") });
      expect(new URL(String((fetchMock.mock.calls[0] as unknown[])[0])).host).toBe("api.example.com");
    },
  );

  it.each(["127.0.0.1", "10.1.2.3", "169.254.169.254", "100.64.0.1", "::1", "fd00::1", "::ffff:192.168.1.1"])(
    "refuses a granted origin whose DNS points at %s",
    async (address) => {
      await expect(extensionFetch({ ...base, url: "https://api.example.com/x", lookup: resolvesTo(address) })).rejects.toMatchObject({ status: 403 });
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("refuses ungranted origins, credentials and plain HTTP", async () => {
    const lookup = resolvesTo("93.184.216.34");
    for (const url of ["https://other.example.com/", "https://u:p@api.example.com/", "http://api.example.com/"]) {
      await expect(extensionFetch({ ...base, url, lookup })).rejects.toMatchObject({ status: 403 });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses when DNS fails", async () => {
    await expect(extensionFetch({ ...base, url: "https://api.example.com/", lookup: async () => { throw new Error("ENOTFOUND"); } })).rejects.toMatchObject({ status: 403 });
  });
});
