#!/usr/bin/env node
import process from "node:process";
import { seedStarterContent } from "../lib/setup/owner/starterContent.mjs";
import { loadLocalEnv } from "./lib/loadLocalEnv.mjs";
import { scriptAuthProvider, signInToCms } from "./lib/cmsSession.mjs";

function parseArgs(argv) {
  return Object.fromEntries(argv.filter((value) => value.startsWith("--")).map((value) => {
    const [key, ...rest] = value.slice(2).split("=");
    return [key, rest.join("=")];
  }));
}

loadLocalEnv();
const args = parseArgs(process.argv.slice(2));
if (Object.prototype.hasOwnProperty.call(args, "help")) {
  console.log("Usage: npm run seed:starter -- [--url=http://localhost:3000] [--email=owner@example.com] [--password=owner-password] [--code=123456]");
  console.log("The command is idempotent and creates a starter Article model and draft welcome entry through the authenticated CMS API.");
  console.log("With the built-in auth (AUTH_PROVIDER=builtin), --code is the 6-digit code from the owner's authenticator app, or one recovery code.");
  process.exit(0);
}

const provider = scriptAuthProvider(process.env.AUTH_PROVIDER);
const appUrl = String(args.url || process.env.POLYNOVEA_CMS_URL || process.env.POLYNOVEA_PUBLIC_URL || "http://localhost:3000").replace(/\/$/, "");
const email = String(args.email || process.env.POLYNOVEA_BOOTSTRAP_ADMIN_EMAIL || "").trim().toLowerCase();
const password = String(args.password || process.env.POLYNOVEA_BOOTSTRAP_ADMIN_PASSWORD || "");
if (!email || password.length < 8) throw new Error("Supply the owner email and password through arguments or POLYNOVEA_BOOTSTRAP_ADMIN_* variables.");

const cms = await signInToCms({
  provider,
  baseUrl: appUrl,
  email,
  password,
  code: args.code || process.env.POLYNOVEA_OWNER_OTP,
  supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL?.trim(),
  anonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim(),
});

// The same idempotent starter content the setup wizard creates (lib/setup/owner/starterContent.mjs),
// here through the authenticated CMS API.
const result = await seedStarterContent({
  listModels: () => cms.request("/api/models"),
  createModel: async (input) => {
    const created = await cms.request("/api/models", { method: "POST", body: JSON.stringify(input) });
    return created?.model || created;
  },
  listEntries: (modelId) => cms.request(`/api/entries?modelId=${encodeURIComponent(modelId)}`),
  createEntry: async (input) => {
    const created = await cms.request("/api/entries", { method: "POST", body: JSON.stringify(input) });
    return created?.entry || created;
  },
});

console.log(JSON.stringify({ ...result, next: `${appUrl}/admin/entries/${result.entry.id}` }, null, 2));
