#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import process from "node:process";
import { createClient } from "@supabase/supabase-js";
import pg from "pg";
import { postgresConnectionConfig } from "../lib/infrastructure/postgresTls.mjs";
import { adminBackend, postgresAdminStore, supabaseAdminStore } from "./lib/bootstrapAdminStore.mjs";
import { bootstrapBuiltinOwner } from "../lib/auth/bootstrapOwner.mjs";

function loadLocalEnv() {
  if (!existsSync(".env.local")) return;
  for (const raw of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match || process.env[match[1]]) continue;
    process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, "");
  }
}

function parseArgs(argv) {
  const args = {};
  for (const value of argv) {
    if (!value.startsWith("--")) continue;
    const [key, ...rest] = value.slice(2).split("=");
    args[key] = rest.join("=");
  }
  return args;
}

function defaultUsername(email) {
  const local = email.split("@")[0] || "owner";
  const normalized = local.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return (normalized || "owner").slice(0, 40);
}

async function findAuthUserByEmail(client, email) {
  for (let page = 1; page <= 100; page += 1) {
    const { data, error } = await client.auth.admin.listUsers({ page, perPage: 100 });
    if (error) throw error;
    const found = data.users.find((user) => user.email?.toLowerCase() === email);
    if (found) return found;
    if (data.users.length < 100) break;
  }
  return null;
}

/** Piped (non-terminal) input, read once and handed out a line at a time. */
let pipedLines = null;
function readPipedLines() {
  pipedLines ??= new Promise((resolve) => {
    let text = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { text += chunk; });
    process.stdin.once("end", () => resolve(text.split(/\r?\n/)));
    process.stdin.resume();
  });
  return pipedLines;
}

/** Reads a line from the terminal without echoing it. Piped input is read as plain lines. */
async function promptHidden(question) {
  const input = process.stdin;
  process.stderr.write(question);
  if (!input.isTTY) {
    const lines = await readPipedLines();
    process.stderr.write("\n");
    return lines.shift() ?? "";
  }
  return new Promise((resolve, reject) => {
    let value = "";
    input.setRawMode(true);
    input.setEncoding("utf8");
    const done = (error) => {
      input.setRawMode(false);
      input.off("data", onKey);
      input.pause();
      process.stderr.write("\n");
      if (error) reject(error); else resolve(value);
    };
    const onKey = (chunk) => {
      for (const char of chunk) {
        if (char === "\r" || char === "\n") return done();
        if (char === "\u0003") return done(new Error("Cancelled."));
        if (char === "\u007f" || char === "\b") value = value.slice(0, -1);
        else if (char >= " ") value += char;
      }
    };
    input.on("data", onKey);
    input.resume();
  });
}

async function bootstrapBuiltin({ email, username, displayName, workspaceSlug, password }) {
  const connectionString = process.env.POLYNOVEA_DATABASE_URL || process.env.DATABASE_URL;
  if (!connectionString) throw new Error("POLYNOVEA_DATABASE_URL (or DATABASE_URL) is required for the built-in auth.");
  const db = new pg.Client(postgresConnectionConfig(connectionString));
  await db.connect();
  try {
    let chosen = password || null;
    if (!chosen) {
      const { rowCount } = await db.query(
        `select 1 from polynovea_auth."user" u join polynovea_auth.account a on a."userId" = u.id and a."providerId" = 'credential' and a.password is not null where u.email = $1`,
        [email],
      );
      if (rowCount === 0) {
        console.error(`Choose a password for ${email}: at least 15 characters; a long phrase is best.`);
        chosen = await promptHidden("Password: ");
        const again = await promptHidden("Repeat it: ");
        if (chosen !== again) throw new Error("The passwords do not match.");
      }
    }
    const result = await bootstrapBuiltinOwner(db, { email, password: chosen, username, displayName, workspaceSlug });
    if (!result.createdUser) console.log(result.setPassword ? `Existing sign-in for ${email} reused; its password was set.` : `Existing sign-in for ${email} reused; its password was not changed.`);
    console.log("At first sign-in the owner is asked to add two sign-in methods (passkeys or an authenticator app) before using the CMS.");
  } finally {
    await db.end();
  }
}

loadLocalEnv();
const args = parseArgs(process.argv.slice(2));
if (Object.prototype.hasOwnProperty.call(args, "help")) {
  console.log('Usage: npm run bootstrap:admin -- --email=owner@example.com [--password=change-me-now] [--username=owner] [--display-name="Owner"] [--workspace=polynovea]');
  console.log("When --password or POLYNOVEA_BOOTSTRAP_ADMIN_PASSWORD is set, a missing auth identity is created automatically.");
  console.log("With AUTH_PROVIDER=builtin the owner is created in the built-in auth; with no password given, it is asked for without echo (safer than --password, which shells keep in their history).");
  process.exit(0);
}
const email = String(args.email || process.env.POLYNOVEA_BOOTSTRAP_ADMIN_EMAIL || "").trim().toLowerCase();
const username = String(args.username || process.env.POLYNOVEA_BOOTSTRAP_ADMIN_USERNAME || defaultUsername(email)).trim().toLowerCase();
const displayName = String(args["display-name"] || process.env.POLYNOVEA_BOOTSTRAP_ADMIN_DISPLAY_NAME || username).trim();
const workspaceSlug = String(args.workspace || process.env.POLYNOVEA_DEFAULT_WORKSPACE_SLUG || "polynovea").trim().toLowerCase();
const password = String(args.password || process.env.POLYNOVEA_BOOTSTRAP_ADMIN_PASSWORD || "");

if (!email || !email.includes("@")) {
  console.error("Usage: npm run bootstrap:admin -- --email=owner@example.com [--username=owner] [--display-name=\"Owner\"]");
  process.exit(2);
}
if (!/^[a-z0-9._-]{3,40}$/i.test(username)) {
  console.error("Bootstrap username must be 3-40 characters using letters, numbers, dot, underscore, or hyphen.");
  process.exit(2);
}

if ((process.env.AUTH_PROVIDER ?? "").trim().toLowerCase() === "builtin") {
  try {
    await bootstrapBuiltin({ email, username, displayName, workspaceSlug, password });
    console.log(`Bootstrap complete: ${email} is the active master/owner for workspace '${workspaceSlug}'.`);
    process.exit(0);
  } catch (error) {
    console.error(`Bootstrap failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
if (!supabaseUrl || !serviceRoleKey) {
  console.error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required. Put them in .env.local or the process environment.");
  process.exit(2);
}

const client = createClient(supabaseUrl, serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

try {
  let authUser = await findAuthUserByEmail(client, email);
  if (!authUser) {
    if (password.length < 8) {
      throw new Error(`No Supabase Auth user exists for ${email}. Set POLYNOVEA_BOOTSTRAP_ADMIN_PASSWORD (8+ characters) to create it, or create the identity first.`);
    }
    const { data, error } = await client.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    if (error || !data.user) throw error || new Error(`Failed to create the auth identity for ${email}.`);
    authUser = data.user;
  }

  // The admin, membership and owner-role writes follow the `admin` area of POLYNOVEA_DATA_BACKEND.
  if (adminBackend(process.env.POLYNOVEA_DATA_BACKEND) === "postgres") {
    const connectionString = process.env.POLYNOVEA_DATABASE_URL || process.env.DATABASE_URL;
    if (!connectionString) throw new Error("POLYNOVEA_DATABASE_URL (or DATABASE_URL) is required when the admin area uses PostgreSQL.");
    const db = new pg.Client(postgresConnectionConfig(connectionString));
    await db.connect();
    try {
      await postgresAdminStore(db).grantOwner({ authUserId: authUser.id, email, username, displayName, workspaceSlug });
    } finally {
      await db.end();
    }
  } else {
    await supabaseAdminStore(client).grantOwner({ authUserId: authUser.id, email, username, displayName, workspaceSlug });
  }

  console.log(`Bootstrap complete: ${email} is the active master/owner for workspace '${workspaceSlug}'.`);
} catch (error) {
  console.error(`Bootstrap failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
