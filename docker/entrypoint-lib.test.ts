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
