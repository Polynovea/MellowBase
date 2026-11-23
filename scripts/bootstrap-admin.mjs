#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import process from "node:process";
import { createClient } from "@supabase/supabase-js";
import pg from "pg";
import { postgresConnectionConfig } from "../lib/infrastructure/postgresTls.mjs";
import { adminBackend, postgresAdminStore, supabaseAdminStore } from "./lib/bootstrapAdminStore.mjs";

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

loadLocalEnv();
const args = parseArgs(process.argv.slice(2));
if (Object.prototype.hasOwnProperty.call(args, "help")) {
  console.log('Usage: npm run bootstrap:admin -- --email=owner@example.com [--password=change-me-now] [--username=owner] [--display-name="Owner"] [--workspace=polynovea]');
  console.log("When --password or POLYNOVEA_BOOTSTRAP_ADMIN_PASSWORD is set, a missing auth identity is created automatically.");
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
