#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import process from "node:process";
import { createClient } from "@supabase/supabase-js";
import { seedStarterContent } from "../lib/setup/owner/starterContent.mjs";

function loadLocalEnv() {
  if (!existsSync(".env.local")) return;
  for (const raw of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
    const match = raw.trim().match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, "");
  }
}

function parseArgs(argv) {
  return Object.fromEntries(argv.filter((value) => value.startsWith("--")).map((value) => {
    const [key, ...rest] = value.slice(2).split("=");
    return [key, rest.join("=")];
  }));
}

async function apiRequest(baseUrl, path, token, init = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...init.headers },
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(body?.error || body?.message || `${response.status} ${response.statusText}`);
  return body?.data;
}

loadLocalEnv();
const args = parseArgs(process.argv.slice(2));
if (Object.prototype.hasOwnProperty.call(args, "help")) {
  console.log("Usage: npm run seed:starter -- [--url=http://localhost:3000] [--email=owner@example.com] [--password=owner-password]");
  console.log("The command is idempotent and creates a starter Article model and draft welcome entry through the authenticated CMS API.");
  process.exit(0);
}

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim();
const appUrl = String(args.url || process.env.POLYNOVEA_CMS_URL || "http://localhost:3000").replace(/\/$/, "");
const email = String(args.email || process.env.POLYNOVEA_BOOTSTRAP_ADMIN_EMAIL || "").trim().toLowerCase();
const password = String(args.password || process.env.POLYNOVEA_BOOTSTRAP_ADMIN_PASSWORD || "");
if (!supabaseUrl || !anonKey) throw new Error("NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY are required.");
if (!email || password.length < 8) throw new Error("Supply the bootstrap owner email and password through arguments or POLYNOVEA_BOOTSTRAP_ADMIN_* variables.");

const auth = createClient(supabaseUrl, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
const { data: login, error: loginError } = await auth.auth.signInWithPassword({ email, password });
if (loginError || !login.session) throw loginError || new Error("Owner sign-in did not return a session.");
const token = login.session.access_token;

// The same idempotent starter content the setup wizard creates (lib/setup/owner/starterContent.mjs),
// here through the authenticated CMS API.
const result = await seedStarterContent({
  listModels: () => apiRequest(appUrl, "/api/models", token),
  createModel: async (input) => {
    const created = await apiRequest(appUrl, "/api/models", token, { method: "POST", body: JSON.stringify(input) });
    return created?.model || created;
  },
  listEntries: (modelId) => apiRequest(appUrl, `/api/entries?modelId=${encodeURIComponent(modelId)}`, token),
  createEntry: async (input) => {
    const created = await apiRequest(appUrl, "/api/entries", token, { method: "POST", body: JSON.stringify(input) });
    return created?.entry || created;
  },
});

console.log(JSON.stringify({ ...result, next: `${appUrl}/admin/entries/${result.entry.id}` }, null, 2));
