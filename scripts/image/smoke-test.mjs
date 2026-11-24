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
 *   STEPS        comma list of: health, forged, code, local, owner-step, refused, schema-roundtrip
 *                (default health,code,local,owner-step). schema-roundtrip finishes the owner step, signs in
 *                and drives a model edit to the table (it must follow code, local and owner-step).
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

if (STEPS.has("schema-roundtrip")) {
  // Phase 4: a model edited through the CMS reaches the table, applied by the schema worker running
  // INSIDE this image. Secrets (owner password, TOTP secret, recovery codes, master key and backup
  // password) are generated or read per run and stay in memory: never printed, never written.
  const { randomBytes } = await import("node:crypto");
  const { readdirSync, readFileSync } = await import("node:fs");
  const { createOTP } = await import("@better-auth/utils/otp");
  const { base32 } = await import("@better-auth/utils/base32");
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const must = async (response, what) => {
    if (response.ok) return response.status === 204 ? null : response.json();
    fail(`${what}: ${response.status} ${(await response.text()).slice(0, 300)}`);
  };

  // 1. Finish the owner step (the wizard's own endpoints, with the setup session cookie).
  const email = `smoke-owner-${randomBytes(4).toString("hex")}@example.test`;
  const password = `smoke ${randomBytes(18).toString("base64url")}`;
  await must(await post("/api/setup/owner/account", { email, displayName: "Smoke Owner", password }), "owner account");
  const totpStart = await must(await post("/api/setup/owner/totp-start", {}), "totp start");
  const totpSecret = new URL(totpStart.data?.totpURI ?? totpStart.totpURI).searchParams.get("secret");
  const totp = () => createOTP(base32.decode(totpSecret)).totp();
  await must(await post("/api/setup/owner/totp-confirm", { code: await totp() }), "totp confirm");
  const recovery = await must(await post("/api/setup/owner/recovery-codes", {}), "recovery codes");
  const { codes, confirmNumber } = recovery.data ?? recovery;
  await must(await post("/api/setup/owner/recovery-confirm", { code: codes[confirmNumber - 1] }), "recovery confirm");
  await must(await post("/api/setup/owner/organisation", { organisationName: "Smoke", workspaceName: "Smoke", starterContent: false }), "organisation");
  const keys = await must(await post("/api/setup/owner/keys-reveal", {}), "keys reveal");
  const { masterKey, backupRepoPassword } = keys.data ?? keys;
  await must(await post("/api/setup/owner/keys-confirm", { masterKeyTail: masterKey?.slice(-6), backupTail: backupRepoPassword?.slice(-6) }), "keys confirm");
  await must(await post("/api/setup/owner/finish", {}), "finish");
  ok("owner created through the wizard (password, authenticator, recovery codes, keys confirmed)");

  // 2. Sign in like the admin UI: password, then the authenticator code; CSRF token for the session.
  const jar = new Map();
  const jarHeader = () => [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
  async function auth(path, body) {
    const response = await fetch(`${BASE}/api/auth${path}`, { method: "POST", headers: { origin: BASE, "content-type": "application/json", ...(jar.size ? { cookie: jarHeader() } : {}) }, body: JSON.stringify(body) });
    for (const setCookie of response.headers.getSetCookie()) {
      const [pair, ...attributes] = setCookie.split(";");
      const eq = pair.indexOf("=");
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (!value || attributes.some((attribute) => /max-age=0\b/i.test(attribute.trim()))) jar.delete(name);
      else jar.set(name, value);
    }
    return response;
  }
  await must(await auth("/sign-in/email", { email, password }), "sign in");
  let verified = await auth("/two-factor/verify-totp", { code: await totp() });
  if (!verified.ok) { // the enrolment already used this window's code: wait for the next one
    await sleep(31_000);
    verified = await auth("/two-factor/verify-totp", { code: await totp() });
  }
  await must(verified, "authenticator code at sign-in");
  const csrf = (await must(await fetch(`${BASE}/api/auth/csrf`, { headers: { cookie: jarHeader() } }), "csrf token")).data.token;
  const admin = (method, path, body) => fetch(`${BASE}${path}`, {
    method, headers: { origin: BASE, cookie: jarHeader(), "x-polynovea-csrf": csrf, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  ok("signed in as the owner with the authenticator code");

  // 3. A model created in the admin gets its table and is served from it (no content:move).
  const apiKey = `smoke_note_${randomBytes(3).toString("hex")}`;
  const field = (key) => ({ key, label: key, type: "text", required: false, localized: false, unique: false });
  const schemaWith = (...keys) => ({ name: "Smoke Note", apiKey, fields: keys.map(field) });
  const created = await must(await admin("POST", "/api/models", { schema: schemaWith("title") }), "create model");
  const modelId = created.data.model.id;
  const token = (await must(await admin("POST", "/api/developer/tokens", { name: `smoke-${apiKey}`, scopes: ["content.read", "content.preview", "schema.read"] }), "api token")).data.secret;
  const items = (query) => fetch(`${BASE}/api/v1/models/${apiKey}/items?variant=draft&${query}`, { headers: { authorization: `Bearer ${token}` } });
  const openChanges = async () => (await must(await admin("GET", `/api/models/${modelId}`), "model")).data.schemaChanges ?? [];
  // A filter needs the model's table: 200 means served from the table, 503 MODEL_TABLE_NOT_READY means snapshots.
  async function waitForTable(filterField, label) {
    for (let i = 0; i < 45; i += 1) {
      const response = await items(`filter=${encodeURIComponent(JSON.stringify({ [filterField]: { null: false } }))}`);
      if (response.status === 200 && (await openChanges()).length === 0) return;
      await sleep(2_000);
    }
    fail(`${label}: the change did not reach the table within 90s (open changes: ${JSON.stringify(await openChanges())})`);
  }
  await waitForTable("title", "new model");
  ok("a new model got its table from the schema worker and is served from it");

  // 4. Adding a field: applied by the worker; the table serves the new field.
  await must(await admin("POST", `/api/models/${modelId}/apply-change`, { schema: schemaWith("title", "subtitle"), changeSummary: "smoke: add subtitle", acknowledgeUnsafe: false }), "add field");
  await waitForTable("subtitle", "added field");
  await must(await admin("POST", "/api/entries", { modelId, data: { title: "Hello", subtitle: "From the table" } }), "create entry");
  const served = await must(await items(`filter=${encodeURIComponent(JSON.stringify({ subtitle: { eq: "From the table" } }))}`), "items with the new field");
  if (served.data?.[0]?.data?.subtitle !== "From the table") fail(`items API did not serve the new field: ${JSON.stringify(served.data)}`);
  ok("an added field reached succeeded and the items API serves it from the table");

  // 5. The test can see the difference: with the schema worker paused, the same kind of edit stays
  //    pending and the API reads from snapshots (a filter answers 503 MODEL_TABLE_NOT_READY).
  const workerPid = readdirSync("/proc").filter((entry) => /^\d+$/.test(entry)).find((pid) => {
    try { return readFileSync(`/proc/${pid}/cmdline`, "utf8").includes("dist/schema-migration-worker.mjs"); } catch { return false; }
  });
  if (!workerPid) fail("no schema worker process to pause");
  process.kill(Number(workerPid), "SIGSTOP");
  try {
    await must(await admin("POST", `/api/models/${modelId}/apply-change`, { schema: schemaWith("title", "subtitle", "extra"), changeSummary: "smoke: add extra", acknowledgeUnsafe: false }), "add field while paused");
    await sleep(8_000);
    const pending = await openChanges();
    if (!pending.some((change) => change.stage === "expand" && change.status === "pending")) fail(`with the worker paused the change is not pending: ${JSON.stringify(pending)}`);
    const blocked = await items(`filter=${encodeURIComponent(JSON.stringify({ title: { null: false } }))}`);
    const body = await blocked.json().catch(() => ({}));
    if (blocked.status !== 503 || body.error?.code !== "MODEL_TABLE_NOT_READY") fail(`with the worker paused reads were not on snapshots: ${blocked.status} ${JSON.stringify(body)}`);
    const plain = await items("");
    if (plain.status !== 200) fail(`plain reads must keep working from snapshots: ${plain.status}`);
    ok("with the schema worker paused: the change stays pending and reads come from snapshots");
  } finally {
    process.kill(Number(workerPid), "SIGCONT");
  }
  await waitForTable("extra", "after resuming the worker");
  ok("after resuming, the change reached succeeded and the table serves again");
  console.log(`SCHEMA_ROUNDTRIP_MODEL=${apiKey}`);
}
