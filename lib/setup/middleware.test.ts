import { describe, expect, it, vi } from "vitest";

const mode = vi.hoisted(() => ({ current: "setup" as "setup" | "running" | "unavailable" }));
vi.mock("@/lib/setup/mode", () => ({ resolveMode: async () => ({ mode: mode.current }) }));

const { NextRequest } = await import("next/server");
const { config, gateDecision, middleware } = await import("@/middleware");
const { announceSetupAccess, listensOnPublicAddress, setupUrl } = await import("@/lib/setup/bootTasks");

const request = (path: string) => new NextRequest(new URL(path, "https://cms.example.com"));

describe("setup gate decisions", () => {
  it("setup mode: only the wizard, its assets and health", () => {
    for (const path of ["/setup", "/setup/database", "/api/setup/status", "/api/setup/code", "/api/health", "/_next/static/chunks/app.js", "/favicon.ico"]) {
      expect(gateDecision(path, "setup"), path).toBe("pass");
    }
    for (const path of ["/", "/admin", "/login", "/api/auth/sign-in/email", "/api/v1/content", "/_next/image", "/setupx", "/api/setupx", "/api/health/extra", "/_next/webpack-hmr"]) {
      expect(gateDecision(path, "setup"), path).toBe("setup-required");
    }
    expect(gateDecision("/_next/webpack-hmr", "setup", { dev: true })).toBe("pass");
  });

  it("running mode: the wizard is gone, everything else passes", () => {
    for (const path of ["/setup", "/setup/owner", "/api/setup/status", "/api/setup/owner"]) expect(gateDecision(path, "running"), path).toBe("not-found");
    for (const path of ["/", "/admin", "/api/v1/content", "/api/health"]) expect(gateDecision(path, "running"), path).toBe("pass");
  });

  it("unavailable mode: only health answers, and never the wizard", () => {
    expect(gateDecision("/api/health", "unavailable")).toBe("pass");
    for (const path of ["/setup", "/api/setup/status", "/admin", "/"]) expect(gateDecision(path, "unavailable"), path).toBe("unavailable");
  });

  it("runs on Node and covers everything but the static build output", () => {
    expect(config.runtime).toBe("nodejs");
    const matcher = new RegExp(`^${config.matcher[0]}$`);
    expect(matcher.test("/admin")).toBe(true);
    expect(matcher.test("/_next/image")).toBe(true);
    expect(matcher.test("/_next/static/chunks/app.js")).toBe(false);
  });
});

describe("middleware responses", () => {
  it("setup mode: 503 with a link to /setup, as HTML for pages and JSON for the API", async () => {
    mode.current = "setup";
    const page = await middleware(request("/admin"));
    expect(page.status).toBe(503);
    expect(await page.text()).toContain('href="/setup"');
    const api = await middleware(request("/api/v1/content"));
    expect(api.status).toBe(503);
    expect(await api.json()).toEqual({ error: "Setup is not finished", setup: "/setup" });
    expect((await middleware(request("/setup"))).headers.get("x-middleware-next")).toBe("1");
  });

  it("running mode: /setup and /api/setup/* are 404", async () => {
    mode.current = "running";
    expect((await middleware(request("/setup"))).status).toBe(404);
    expect((await middleware(request("/api/setup/status"))).status).toBe(404);
    expect((await middleware(request("/admin"))).headers.get("x-middleware-next")).toBe("1");
  });

  it("unavailable mode: 503 without pointing at setup", async () => {
    mode.current = "unavailable";
    const response = await middleware(request("/setup"));
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain('href="/setup"');
  });
});

describe("boot announcements", () => {
  it("warns only when listening beyond loopback", () => {
    expect(listensOnPublicAddress({})).toBe(true);
    expect(listensOnPublicAddress({ HOSTNAME: "0.0.0.0" })).toBe(true);
    expect(listensOnPublicAddress({ HOSTNAME: "a1b2c3d4e5f6" })).toBe(true);
    expect(listensOnPublicAddress({ HOSTNAME: "127.0.0.1" })).toBe(false);
    expect(listensOnPublicAddress({ HOST: "localhost" })).toBe(false);
    expect(listensOnPublicAddress({ HOSTNAME: "::1" })).toBe(false);
  });

  it("logs the setup URL, and the code only when one is given", () => {
    expect(setupUrl({ POLYNOVEA_PUBLIC_URL: "https://cms.example.com/" })).toBe("https://cms.example.com/setup");
    expect(setupUrl({ HOSTNAME: "127.0.0.1", PORT: "8080" })).toBe("http://127.0.0.1:8080/setup");
    const info = vi.fn();
    const logger = { info, warn: vi.fn(), error: vi.fn() };
    announceSetupAccess({ env: { POLYNOVEA_PUBLIC_URL: "https://cms.example.com" }, logger });
    expect(info.mock.calls[0][0]).toContain("https://cms.example.com/setup");
    expect(info.mock.calls[0][0]).not.toContain("Setup code");
    announceSetupAccess({ env: {}, logger, code: "ABCD-EFGH" });
    expect(info.mock.calls[1][0]).toContain("Setup code: ABCD-EFGH");
  });
});
