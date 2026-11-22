import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";

// Creates a fresh owner for this run with the existing bootstrap:admin script. The password is
// random per run and only passed through the environment, never written to a file.
export default function globalSetup() {
  const email = `e2e-owner-${randomBytes(4).toString("hex")}@example.test`;
  const password = randomBytes(18).toString("base64url");
  execFileSync(process.execPath, ["scripts/bootstrap-admin.mjs", `--email=${email}`], {
    stdio: "inherit",
    env: { ...process.env, POLYNOVEA_BOOTSTRAP_ADMIN_PASSWORD: password },
  });
  process.env.E2E_OWNER_EMAIL = email;
  process.env.E2E_OWNER_PASSWORD = password;
}
