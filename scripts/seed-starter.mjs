#!/usr/bin/env node
import process from "node:process";
import { seedStarterContent } from "../lib/setup/owner/starterContent.mjs";
import { loadLocalEnv } from "./lib/loadLocalEnv.mjs";
import { scriptAuthProvider, signInToCms } from "./lib/cmsSession.mjs";
import { promptHidden } from "./lib/hiddenPrompt.mjs";

function parseArgs(argv) {
  return Object.fromEntries(argv.filter((value) => value.startsWith("--")).map((value) => {
    const [key, ...rest] = value.slice(2).split("=");
    return [key, rest.join("=")];
  }));
}

loadLocalEnv();
const args = parseArgs(process.argv.slice(2));
if (Object.prototype.hasOwnProperty.call(args, "help")) {
  console.log("Usage: npm run seed:starter -- [--url=https://cms.example.com] [--email=owner@example.com]");
  console.log("The command is idempotent and creates a starter Article model and draft welcome entry through the authenticated CMS API.");
  console.log("The password comes from POLYNOVEA_BOOTSTRAP_ADMIN_PASSWORD, or you are asked for it (nothing is shown as you type).");
  console.log("With the built-in auth, the one-time code comes from POLYNOVEA_OWNER_OTP, or you are asked for it.");
  console.log("Secrets are never accepted as command-line arguments: those end up in shell history and the process list.");
  process.exit(0);
}
for (const secret of ["password", "code", "otp"]) {
  if (Object.prototype.hasOwnProperty.call(args, secret)) {
    console.error(`--${secret} is not accepted: command-line arguments end up in your shell history and the process list. Set ${secret === "password" ? "POLYNOVEA_BOOTSTRAP_ADMIN_PASSWORD" : "POLYNOVEA_OWNER_OTP"}, or leave it out to be asked for it.`);
    process.exit(2);
  }
}

const provider = scriptAuthProvider(process.env.AUTH_PROVIDER);
const appUrl = String(args.url || process.env.POLYNOVEA_CMS_URL || process.env.POLYNOVEA_PUBLIC_URL || "http://localhost:3000").replace(/\/$/, "");
const email = String(args.email || process.env.POLYNOVEA_BOOTSTRAP_ADMIN_EMAIL || "").trim().toLowerCase();
const password = process.env.POLYNOVEA_BOOTSTRAP_ADMIN_PASSWORD || await promptHidden(`Password for ${email || "the owner"}: `);
if (!email || password.length < 8) throw new Error("Supply the owner email (--email or POLYNOVEA_BOOTSTRAP_ADMIN_EMAIL) and password (POLYNOVEA_BOOTSTRAP_ADMIN_PASSWORD, or type it when asked).");

const cms = await signInToCms({
  provider,
  baseUrl: appUrl,
  email,
  password,
  code: async () => process.env.POLYNOVEA_OWNER_OTP || promptHidden("One-time code from your authenticator app (or a recovery code): "),
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
