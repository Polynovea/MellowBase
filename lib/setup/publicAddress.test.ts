import { describe, expect, it } from "vitest";
import { addressMismatch, configuredOrigin, expectedAddress } from "@/lib/setup/publicAddress";

describe("setup pages: the address the CMS expects (POLYNOVEA_PUBLIC_URL)", () => {
  it("reads the configured address as an origin; unset or not a web address is null", () => {
    expect(configuredOrigin("http://localhost:3000/")).toBe("http://localhost:3000");
    expect(configuredOrigin(" https://cms.example.com/admin ")).toBe("https://cms.example.com");
    expect(configuredOrigin(undefined)).toBeNull();
    expect(configuredOrigin("  ")).toBeNull();
    expect(configuredOrigin("not a url")).toBeNull();
    expect(configuredOrigin("javascript:alert(1)")).toBeNull();
  });

  it("gives the ssh command for the configured local port; a domain gets none", () => {
    expect(expectedAddress("http://localhost:3000")).toEqual({ origin: "http://localhost:3000", tunnelCommand: "ssh -L 3000:127.0.0.1:3000 you@your-server" });
    expect(expectedAddress("http://localhost:8080").tunnelCommand).toBe("ssh -L 8080:127.0.0.1:8080 you@your-server");
    expect(expectedAddress("https://cms.example.com").tunnelCommand).toBeNull();
  });

  it("warns when the browser is on another address: 127.0.0.1 is not localhost, and the port counts", () => {
    expect(addressMismatch("http://localhost:3000", "http://localhost:3000")).toBe(false);
    expect(addressMismatch("http://localhost:3000", "http://127.0.0.1:3000")).toBe(true);
    expect(addressMismatch("http://localhost:3000", "http://localhost:8080")).toBe(true);
    // Before the page has run in the browser, nothing is known: no warning.
    expect(addressMismatch("http://localhost:3000", null)).toBe(false);
  });
});
