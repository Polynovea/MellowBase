import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkBaseUrl, typesPull } from "../lib/typesPull.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = readFileSync(resolve(here, "../../cms-sdk/test/fixture/polynovea-cms.ts"), "utf8");
const TOKEN = "pnv_cli_secret_token";

function run(flags: Record<string, unknown>, fetchImpl: typeof fetch, cwd: string, env: Record<string, string> = { POLYNOVEA_CMS_TOKEN: TOKEN }) {
  const out: string[] = [];
  const err: string[] = [];
  return typesPull({ flags, env, cwd, fetch: fetchImpl, log: (m: string) => out.push(m), error: (m: string) => err.push(m) })
    .then((code: number) => ({ code, out: out.join("\n"), err: err.join("\n") }));
}
const serve = (body: string, status = 200, contentType = "text/plain; charset=utf-8") =>
  (async () => new Response(body, { status, headers: { "content-type": contentType } })) as unknown as typeof fetch;

describe("polynovea-cms types pull", () => {
  let dir: string;
  beforeAll(() => { dir = mkdtempSync(join(tmpdir(), "pnv-types-")); });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("writes the file and asks with the env token, never printing it", async () => {
    let seen: { url: string; auth: string | null; redirect?: string } | null = null;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen = { url, auth: new Headers(init.headers).get("authorization"), redirect: init.redirect };
      return new Response(FIXTURE, { status: 200 });
    }) as unknown as typeof fetch;
    const result = await run({ out: "src-types.ts", url: "https://cms.example.test/" }, fetchImpl, dir);
    expect(result.code).toBe(0);
    expect(seen).toEqual({ url: "https://cms.example.test/api/v1/types.ts", auth: `Bearer ${TOKEN}`, redirect: "error" });
    const written = readFileSync(join(dir, "src-types.ts"), "utf8");
    expect(written).toBe(FIXTURE);
    expect(written).not.toContain(TOKEN);
    expect(written).not.toContain("cms.example.test");
    expect(result.out).toContain("2 models");
    expect(result.out + result.err).not.toContain(TOKEN);
  });

  it("--check passes when current (CRLF on disk is fine) and fails on drift or a missing file", async () => {
    writeFileSync(join(dir, "current.ts"), FIXTURE.replace(/\n/g, "\r\n"));
    expect((await run({ out: "current.ts", check: true }, serve(FIXTURE), dir)).code).toBe(0);

    const drifted = FIXTURE.replace(`article: { hash: "${"a".repeat(64)}"`, `article: { hash: "${"e".repeat(64)}"`).replace("  /** rating (integer) */\n  rating?: number;\n", "");
    const result = await run({ out: "current.ts", check: true }, serve(drifted), dir);
    expect(result.code).toBe(1);
    expect(result.err).toContain("out of date");
    expect(result.err).toContain("~ article (aaaaaaaaaaaa -> eeeeeeeeeeee)");
    expect(readFileSync(join(dir, "current.ts"), "utf8")).toBe(FIXTURE.replace(/\n/g, "\r\n")); // --check writes nothing

    const missing = await run({ out: "nope.ts", check: true }, serve(FIXTURE), dir);
    expect(missing.code).toBe(1);
    expect(missing.err).toContain("does not exist");
  });

  it("--check names added and removed models", async () => {
    writeFileSync(join(dir, "models.ts"), FIXTURE);
    const withoutPerson = FIXTURE.replace(/\n {4}person: \{ hash: "b{64}", fields: \[[^\]]*\] \},/, "");
    const result = await run({ out: "models.ts", check: true }, serve(withoutPerson), dir);
    expect(result.code).toBe(1);
    expect(result.err).toContain("- person (no longer readable by this token)");
  });

  it("exits 2 (could not check) on auth failure, a non-types body, or a network error", async () => {
    writeFileSync(join(dir, "c.ts"), FIXTURE);
    const denied = await run({ out: "c.ts", check: true }, serve(JSON.stringify({ error: { code: "INVALID_TOKEN", message: "API token is invalid" } }), 401, "application/json"), dir);
    expect(denied).toMatchObject({ code: 2 });
    expect(denied.err).toContain("INVALID_TOKEN");
    expect((await run({ out: "c.ts", check: true }, serve("<html>login</html>"), dir)).code).toBe(2);
    const offline = (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch;
    expect((await run({ out: "c.ts" }, offline, dir)).code).toBe(2);
  });

  it("refuses a --token flag, and reads --token-file", async () => {
    const flagged = await run({ token: TOKEN }, serve(FIXTURE), dir);
    expect(flagged.code).toBe(2);
    expect(flagged.err).toContain("--token is not accepted");
    expect(flagged.err).not.toContain(TOKEN);

    writeFileSync(join(dir, "token.txt"), `${TOKEN}\n`);
    let auth: string | null = null;
    const fetchImpl = (async (_url: string, init: RequestInit) => { auth = new Headers(init.headers).get("authorization"); return new Response(FIXTURE); }) as unknown as typeof fetch;
    expect((await run({ "token-file": "token.txt", out: "tf.ts" }, fetchImpl, dir, {})).code).toBe(0);
    expect(auth).toBe(`Bearer ${TOKEN}`);
    expect((await run({ out: "tf.ts" }, serve(FIXTURE), dir, {})).code).toBe(2);
  });

  it("requires https except to this machine, and no credentials in the URL", () => {
    expect(checkBaseUrl("https://cms.example.com/")).toBe("https://cms.example.com");
    expect(checkBaseUrl("http://localhost:3000")).toBe("http://localhost:3000");
    expect(checkBaseUrl("http://127.0.0.1:3210")).toBe("http://127.0.0.1:3210");
    expect(checkBaseUrl("http://[::1]:3000")).toBe("http://[::1]:3000");
    expect(checkBaseUrl("http://site.localhost:3000")).toBe("http://site.localhost:3000");
    expect(() => checkBaseUrl("http://cms.example.com")).toThrow(/plain http/);
    expect(() => checkBaseUrl("http://localhost.example.com")).toThrow(/plain http/);
    expect(() => checkBaseUrl("http://10.0.0.5:3000")).toThrow(/plain http/);
    expect(() => checkBaseUrl("https://user:pass@cms.example.com")).toThrow(/user name or password/);
    expect(() => checkBaseUrl("ftp://cms.example.com")).toThrow();
  });
});

describe("polynovea-cms types pull (the real binary against a local server)", () => {
  let server: Server;
  let base: string;
  let dir: string;
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "pnv-types-bin-"));
    server = createServer((req, res) => {
      if (req.url === "/api/v1/types.ts" && req.headers.authorization === `Bearer ${TOKEN}`) {
        res.writeHead(200, { "content-type": "text/plain; charset=utf-8" }).end(FIXTURE);
      } else res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: { code: "INVALID_TOKEN", message: "API token is invalid" } }));
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise((done) => server.close(done));
    rmSync(dir, { recursive: true, force: true });
  });

  const bin = (args: string[], token = TOKEN) => new Promise<{ code: number | null; output: string }>((done) => {
    const child = spawn(process.execPath, [resolve(here, "../bin/polynovea-cms.mjs"), ...args], { cwd: dir, env: { ...process.env, POLYNOVEA_CMS_TOKEN: token } });
    let output = "";
    child.stdout.on("data", (d) => (output += d));
    child.stderr.on("data", (d) => (output += d));
    child.on("close", (code) => done({ code, output }));
  });

  it("pull, then --check passes; a bad token exits 2", async () => {
    expect((await bin(["types", "pull", "--url", base])).code).toBe(0);
    expect(readFileSync(join(dir, "polynovea-cms.ts"), "utf8")).toBe(FIXTURE);
    const check = await bin(["types", "pull", "--url", base, "--check"]);
    expect(check).toMatchObject({ code: 0 });
    expect(check.output).toContain("up to date");
    const bad = await bin(["types", "pull", "--url", base, "--check"], "pnv_wrong");
    expect(bad.code).toBe(2);
    expect(bad.output).not.toContain("pnv_wrong");
  }, 30_000);
});
