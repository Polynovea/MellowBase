#!/usr/bin/env node
/**
 * Server-image smoke test. Runs INSIDE the container (it needs the container's own loopback), fed on
 * stdin by scripts/image/run-smoke.sh:
 *
 *   docker exec -i -e SETUP_CODE=... -e STEPS=... <container> node --input-type=module - < scripts/image/smoke-test.mjs
 *
 * Environment:
 *   SETUP_CODE   the one-time code from the container's log (required for any step after "health")
 *   BASE_URL     where to reach the CMS (default http://localhost:3000: the SSH-tunnel route)
 *   EXPECT_RELEASE  the release ID /api/health must report (optional)
 *   STEPS        comma list of: health, forged, code, local, owner-step, refused (default health,code,local,owner-step)
 *   INSECURE_TLS=1  accept Caddy's internal certificate (proxy-profile test only)
 *
 * Prints one line per check and exits non-zero on the first failure. Never prints the setup code.
 */

const BASE = (process.env.BASE_URL || "http://localhost:3000").replace(/\/+$/, "");
const STEPS = new Set((process.env.STEPS || "health,code,local,owner-step").split(",").map((s) => s.trim()).filter(Boolean));
if (process.env.INSECURE_TLS === "1") process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

let cookie = null;
const ok = (message) => console.log(`ok    ${message}`);
const fail = (message) => {
  console.log(`FAIL  ${message}`);
  process.exit(1);
};

async function post(path, body) {
  return fetch(`${BASE}${path}`, {
    method: "POST",
    headers: {
      origin: BASE,
      "content-type": "application/json",
      "sec-fetch-site": "same-origin",
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(body),
    redirect: "manual",
  });
}

if (STEPS.has("health")) {
  const response = await fetch(`${BASE}/api/health`);
  const body = await response.json().catch(() => null);
  if (response.status !== 200 || body?.state !== "setup") fail(`/api/health should report setup, got ${response.status} ${JSON.stringify(body)}`);
  if (process.env.EXPECT_RELEASE && body.release !== process.env.EXPECT_RELEASE) fail(`/api/health release ${body.release}, expected ${process.env.EXPECT_RELEASE}`);
  ok(`/api/health reports state=setup, release=${body.release}`);
}

if (STEPS.has("refused")) {
  // On a server that cannot prove the request came through a tunnel or HTTPS, setup is refused.
  const response = await post("/api/setup/code", { code: "not-the-code" });
  if (response.status !== 403) fail(`setup over this route should be refused with 403, got ${response.status}`);
  ok("setup refused on this route (403), as designed");
}

if (STEPS.has("forged")) {
  // Tunnel mode trusts no proxy: forwarding headers from 127.0.0.1 must not make a request look like
  // HTTPS or like another address, and their mere presence disqualifies the SSH-tunnel route.
  const response = await fetch(`${BASE}/api/setup/code`, {
    method: "POST",
    headers: {
      origin: "https://cms.example.com",
      "content-type": "application/json",
      "x-forwarded-for": "203.0.113.7",
      "x-forwarded-proto": "https",
      "x-forwarded-host": "cms.example.com",
    },
    body: JSON.stringify({ code: process.env.SETUP_CODE || "not-the-code" }),
  });
  if (response.status !== 403) fail(`forged forwarding headers from 127.0.0.1 should be refused with 403, got ${response.status}`);
  ok("forged X-Forwarded-For/Proto/Host from 127.0.0.1 not trusted in tunnel mode (403; the code was not spent)");
}

if (STEPS.has("code")) {
  if (!process.env.SETUP_CODE) fail("SETUP_CODE is not set");
  const response = await post("/api/setup/code", { code: process.env.SETUP_CODE });
  if (response.status !== 200) fail(`setup code refused: ${response.status} ${await response.text()}`);
  const setCookie = response.headers.get("set-cookie") ?? "";
  const match = /(__Host-polynovea-setup=[^;]+)/.exec(setCookie);
  if (!match) fail("no setup session cookie");
  cookie = match[1];
  ok("setup code accepted; setup session started (peer stamp present under standalone server.js)");
}

if (STEPS.has("local")) {
  const started = Date.now();
  const response = await post("/api/setup/database/local", { kind: "same-server" });
  if (response.status !== 200) fail(`"On this server" refused: ${response.status} ${await response.text()}`);
  const text = await response.text();
  const events = [...text.matchAll(/^data: (.*)$/gm)].map((m) => {
    try {
      return JSON.parse(m[1]);
    } catch {
      return null;
    }
  }).filter(Boolean);
  for (const event of events) {
    if (event.type === "backup" && event.status !== "running") console.log(`      ${event.status.padEnd(6)} ${event.label}`);
    if (event.type === "migration" && event.status === "failed") console.log(`      failed migration ${event.name ?? ""}`);
  }
  const failed = events.find((event) => event.status === "failed" || event.type === "error");
  if (failed) fail(`"On this server" failed: ${JSON.stringify(failed)}`);
  const done = events.find((event) => event.type === "done");
  if (!done || done.databaseMode !== "local") fail(`"On this server" did not finish: last event ${JSON.stringify(events.at(-1))}`);
  ok(`"On this server" provisioned the bundled PostgreSQL with backups in ${Math.round((Date.now() - started) / 1000)}s (${events.length} progress events)`);
}

if (STEPS.has("owner-step")) {
  const status = await fetch(`${BASE}/api/setup/status`).then((r) => r.json());
  if (!status.databaseReady) fail(`database not ready after the database step: ${JSON.stringify(status)}`);
  const page = await fetch(`${BASE}/setup/owner`, { headers: cookie ? { cookie } : {}, redirect: "manual" });
  const html = await page.text();
  if (page.status !== 200 || !/owner/i.test(html)) fail(`owner step page: ${page.status}`);
  ok("the wizard has reached the owner step (database ready, /setup/owner served)");
}
