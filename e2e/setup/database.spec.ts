import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import pg from "pg";

// Phase 2 acceptance tests 5 and 6 for the wizard's database step, against a server in setup mode
// (a clean install: no config.enc, no installation row). The normal e2e server is an installed app,
// where /setup is 404, so these run only when the setup-mode server is given (run with
// `npx playwright test -c playwright.setup.config.ts e2e/setup/database.spec.ts`):
//
//   E2E_SETUP_BASE_URL   base URL of the setup-mode server (e.g. http://127.0.0.1:3200)
//   E2E_SETUP_CODE       its setup code (POLYNOVEA_SETUP_CODE on that server)
//   E2E_SERVER_LOG       file capturing that server's stdout and stderr (acceptance test 6)
//   E2E_CONFIG_DIR       its POLYNOVEA_CONFIG_DIR (acceptance test 6: no file holds the password)
// Optional:
//   E2E_PRIVATE_DNS_NAME a public DNS name that resolves to a private address (default 10.0.0.1.nip.io)
//   E2E_MANAGED_DB_HOST / _PORT / _NAME / _USER  a reachable managed database; the test signs in with a
//                        wrong, unique password so the password is really sent (acceptance test 6)
//   E2E_DATABASE_URL     an owner connection to a database this server provisioned; every row is searched

const base = process.env.E2E_SETUP_BASE_URL;
const code = process.env.E2E_SETUP_CODE;
test.skip(!base || !code, "Set E2E_SETUP_BASE_URL and E2E_SETUP_CODE to run the setup-mode database tests");
test.use({ baseURL: base });

type StreamEvent = { type: string; id?: string; status?: string; message?: string };

// A password that appears nowhere else, so finding it anywhere is a leak.
const SENTINEL = `e2e-admin-${randomBytes(12).toString("hex")}`;
const responses: string[] = [];

async function startSession(page: Page) {
  await page.goto("/setup");
  const status = await page.evaluate(async (setupCode) => {
    const response = await fetch("/api/setup/code", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: setupCode }) });
    return response.status;
  }, code!);
  expect(status).toBe(200);
}

/** Posts the managed-database form the way the page does (fetch, streamed body) and returns the events. */
async function submitManaged(page: Page, form: { hostname: string; port?: number; database?: string; user?: string }): Promise<StreamEvent[]> {
  const text = await page.evaluate(async (body) => {
    const response = await fetch("/api/setup/database/managed", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return `${response.status}\n${await response.text()}`;
  }, { port: 5432, database: "postgres", user: "dbadmin", ...form, password: SENTINEL });
  responses.push(text);
  const [status, ...rest] = text.split("\n");
  expect(status).toBe("200");
  return rest.join("\n").split("\n\n").filter((chunk) => chunk.includes("data: ")).map((chunk) => JSON.parse(chunk.slice(chunk.indexOf("data: ") + 6)) as StreamEvent);
}

test.describe.serial("database step", () => {
  // One setup session for the whole file: the setup code works once, so each test cannot enter it again.
  let page: Page;
  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
    await startSession(page);
  });
  test.afterAll(async () => page?.close());

  // Acceptance test 5.
  for (const hostname of ["169.254.169.254", "127.0.0.1", "localhost", "::ffff:127.0.0.1", "::ffff:169.254.169.254", process.env.E2E_PRIVATE_DNS_NAME ?? "10.0.0.1.nip.io"]) {
    test(`refuses ${hostname} at the address check and never connects`, async () => {
      const events = await submitManaged(page, { hostname });
      expect(events).toContainEqual(expect.objectContaining({ type: "check", id: "dns", status: "failed" }));
      expect(events.some((event) => event.type === "check" && event.id === "tcp")).toBe(false);
      expect(events.at(-1)).toMatchObject({ type: "error" });
    });
  }

  test("a wrong admin password is refused with a plain fix", async () => {
    test.skip(!process.env.E2E_MANAGED_DB_HOST, "Set E2E_MANAGED_DB_HOST to reach a managed database");
    const events = await submitManaged(page, {
      hostname: process.env.E2E_MANAGED_DB_HOST!,
      port: Number(process.env.E2E_MANAGED_DB_PORT ?? 5432),
      database: process.env.E2E_MANAGED_DB_NAME ?? "postgres",
      user: process.env.E2E_MANAGED_DB_USER ?? "postgres",
    });
    expect(events).toContainEqual(expect.objectContaining({ type: "check", id: "login", status: "failed", message: expect.stringMatching(/username or password was not accepted/) }));
  });

  // Acceptance test 6. Runs last, over everything the runs above produced.
  test("the admin password appears in no response, log line, file or database row", async () => {
    expect(responses.length).toBeGreaterThan(0);
    for (const text of responses) expect(text).not.toContain(SENTINEL);

    const log = process.env.E2E_SERVER_LOG;
    expect(log, "E2E_SERVER_LOG must name the setup server's log").toBeTruthy();
    expect(readFileSync(log!, "utf8")).not.toContain(SENTINEL);

    const configDir = process.env.E2E_CONFIG_DIR;
    expect(configDir, "E2E_CONFIG_DIR must name the setup server's config folder").toBeTruthy();
    const files: string[] = [];
    const walk = (dir: string) => {
      if (!existsSync(dir)) return;
      for (const name of readdirSync(dir)) {
        const file = path.join(dir, name);
        if (statSync(file).isDirectory()) walk(file);
        else files.push(file);
      }
    };
    walk(configDir!);
    for (const file of files) expect(readFileSync(file).includes(SENTINEL), file).toBe(false);

    if (process.env.E2E_DATABASE_URL) {
      const client = new pg.Client({ connectionString: process.env.E2E_DATABASE_URL });
      await client.connect();
      try {
        const { rows: tables } = await client.query<{ name: string }>("select format('%I.%I', n.nspname, c.relname) as name from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind in ('r', 'p')");
        for (const { name } of tables) {
          const { rows } = await client.query(`select count(*)::int as n from ${name} t where strpos(t::text, $1) > 0`, [SENTINEL]);
          expect(rows[0].n, name).toBe(0);
        }
      } finally {
        await client.end();
      }
    }
  });
});
