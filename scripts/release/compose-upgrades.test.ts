import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
// eslint-disable-next-line @typescript-eslint/no-require-imports -- js-yaml ships no ESM types here
const yaml = require("js-yaml") as { load: (text: string) => unknown };

type Mount = { type?: string; source?: string; target?: string; read_only?: boolean; bind?: { create_host_path?: boolean } };
type Compose = { services: Record<string, { volumes?: Array<string | Mount> }> };

const base = yaml.load(readFileSync("docker/compose.yaml", "utf8")) as Compose & { "x-cms": { volumes: string[] } };
const overlay = yaml.load(readFileSync("docker/compose.upgrades.yaml", "utf8")) as Compose;

describe("compose: in-app upgrades are an opt-in overlay", () => {
  it("leaves compose.yaml without host mounts, so an install without an agent never gets root-owned folders", () => {
    expect(base["x-cms"].volumes).toEqual(["polynovea-data:/var/lib/polynovea"]);
  });

  it("mounts the request, restore-test, status and key paths for both CMS services, never creating them", () => {
    for (const service of ["cms", "cms-tunnel"]) {
      const mounts = overlay.services[service].volumes as Mount[];
      expect(mounts.map((mount) => mount.target)).toEqual([
        "/var/lib/polynovea/upgrade-requests",
        "/var/lib/polynovea/restore-test",
        "/var/lib/polynovea-upgrade",
        "/etc/polynovea/release.pub",
      ]);
      for (const mount of mounts) {
        expect(mount.type).toBe("bind");
        expect(mount.bind?.create_host_path).toBe(false);
      }
      // The CMS only reads the agent's status and the release key.
      expect(mounts.filter((mount) => mount.read_only).map((mount) => mount.target)).toEqual(["/var/lib/polynovea-upgrade", "/etc/polynovea/release.pub"]);
    }
  });
});
