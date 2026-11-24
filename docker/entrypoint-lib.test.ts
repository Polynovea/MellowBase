import { describe, expect, it } from "vitest";
import * as lib from "./entrypoint-lib.mjs";

const decide = lib.bundledDatabaseDecision as (input: { clusterExists: boolean; readConfig: () => { databaseMode?: string } | null }) => { start: boolean; reason: string };

describe("starting the bundled database at container start", () => {
  it("starts it when the saved settings say this install uses On this server", () => {
    expect(decide({ clusterExists: true, readConfig: () => ({ databaseMode: "local" }) }).start).toBe(true);
  });

  it("leaves a cluster from a failed attempt stopped when the install then chose a managed database", () => {
    for (const databaseMode of ["managed", "created"]) {
      const decision = decide({ clusterExists: true, readConfig: () => ({ databaseMode }) });
      expect(decision.start).toBe(false);
      expect(decision.reason).toContain(databaseMode);
    }
  });

  it("leaves it stopped while setup has saved nothing yet (failed or abandoned attempt)", () => {
    expect(decide({ clusterExists: true, readConfig: () => null }).start).toBe(false);
  });

  it("leaves it stopped when the settings cannot be read, rather than guess", () => {
    expect(decide({ clusterExists: true, readConfig: () => { throw new Error("bad key"); } }).start).toBe(false);
  });

  it("does nothing without a cluster, without reading the settings", () => {
    let read = false;
    expect(decide({ clusterExists: false, readConfig: () => { read = true; return { databaseMode: "local" }; } }).start).toBe(false);
    expect(read).toBe(false);
  });
});

describe("the image runs the built-in sign-in only", () => {
  const problem = (lib as unknown as { authProviderProblem: (env: Record<string, string | undefined>) => string | null }).authProviderProblem;

  it("starts with AUTH_PROVIDER=builtin (what the image sets)", () => {
    expect(problem({ AUTH_PROVIDER: "builtin" })).toBeNull();
    expect(problem({ AUTH_PROVIDER: " Builtin " })).toBeNull();
  });

  it("refuses any override, in plain words: the wizard's owner lives in the built-in auth", () => {
    for (const value of ["supabase", "", undefined, "gotrue"]) {
      const message = problem({ AUTH_PROVIDER: value });
      expect(message).toMatch(/only runs the built-in sign-in/);
      expect(message).toMatch(/Remove AUTH_PROVIDER/);
    }
  });

  it("the Dockerfile builds the browser bundle and runs the server with builtin", async () => {
    const { readFileSync } = await import("node:fs");
    const dockerfile = readFileSync("Dockerfile", "utf8").replace(/\r\n/g, "\n");
    const build = dockerfile.slice(dockerfile.indexOf(" AS build"), dockerfile.indexOf("FROM", dockerfile.indexOf(" AS build") + 1));
    // Build stage: set before `npm run build`, which inlines it into the browser bundle.
    expect(build).toMatch(/\nENV NEXT_PUBLIC_AUTH_PROVIDER=builtin\n/);
    expect(build.indexOf("NEXT_PUBLIC_AUTH_PROVIDER=builtin")).toBeLessThan(build.indexOf("npm run build"));
    // Runtime stage: the server side, in the image's ENV block.
    const runtime = dockerfile.slice(dockerfile.indexOf(" AS runtime"));
    expect(runtime.split("\n").map((line) => line.trim())).toContain("AUTH_PROVIDER=builtin \\");
  });
});
