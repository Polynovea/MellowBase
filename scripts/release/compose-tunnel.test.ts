import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
// eslint-disable-next-line @typescript-eslint/no-require-imports -- js-yaml ships no ESM types here
const yaml = require("js-yaml") as { load: (text: string) => unknown };

// The SSH-tunnel route must set POLYNOVEA_PUBLIC_URL: the setup wizard's passkey step and the built-in
// auth refuse to work without it, so a tunnel install could not finish setup. The default is the
// address the owner opens through the tunnel; an operator's own value (polynovea.env) always wins.

type EnvFile = string | { path: string; required?: boolean };
type Service = { env_file?: EnvFile[]; environment?: Record<string, string> };
const compose = yaml.load(readFileSync("docker/compose.yaml", "utf8")) as { services: Record<string, Service> };
const envPath = (entry: EnvFile) => (typeof entry === "string" ? entry : entry.path);
const settings = (text: string) => text.split(/\r?\n/).filter((line) => line.trim() && !line.trim().startsWith("#"));

describe("tunnel route: the CMS knows the address the owner opens", () => {
  it("compose: the tunnel profile reads tunnel.env, then polynovea.env (so a value there wins)", () => {
    const files = compose.services["cms-tunnel"].env_file ?? [];
    expect(files.map(envPath)).toEqual(["./tunnel.env", "./polynovea.env"]);
    expect(files[1]).toMatchObject({ required: false });
    // Not under `environment:`, which would override polynovea.env.
    expect(compose.services["cms-tunnel"].environment?.POLYNOVEA_PUBLIC_URL).toBeUndefined();
  });

  it("compose: tunnel.env sets exactly POLYNOVEA_PUBLIC_URL=http://localhost:3000", () => {
    expect(settings(readFileSync("docker/tunnel.env", "utf8"))).toEqual(["POLYNOVEA_PUBLIC_URL=http://localhost:3000"]);
  });

  it("compose: the proxy profile keeps its own https address and does not read tunnel.env", () => {
    expect((compose.services.cms.env_file ?? []).map(envPath)).toEqual(["./polynovea.env"]);
    expect(compose.services.cms.environment?.POLYNOVEA_PUBLIC_URL).toBe("https://${POLYNOVEA_DOMAIN:?Set POLYNOVEA_DOMAIN for the proxy profile}");
  });

  it("VM: run-cms.sh defaults to http://localhost:3000 only without a domain and without a value in polynovea.env", () => {
    const script = readFileSync("release/packer/files/run-cms.sh", "utf8").replace(/\r\n/g, "\n");
    expect(script).toMatch(
      /if \[ -n "\$domain" \]; then\n\s+set -- "\$@" -e "POLYNOVEA_PUBLIC_URL=https:\/\/\$domain"[^\n]*\nelif \[ -z "\$\(value POLYNOVEA_PUBLIC_URL "\$ENV_FILE"\)" \]; then\n(?:\s*#[^\n]*\n)*\s+set -- "\$@" -e POLYNOVEA_PUBLIC_URL=http:\/\/localhost:3000\nfi/,
    );
    // The -e comes after --env-file, so it is added only when the env file has no value of its own.
    expect(script.indexOf('--env-file "$ENV_FILE"')).toBeLessThan(script.indexOf("POLYNOVEA_PUBLIC_URL=http://localhost:3000"));
  });
});
