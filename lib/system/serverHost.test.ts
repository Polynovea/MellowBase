import { describe, expect, it } from "vitest";
import { imagePaths, imagePgBackRestEnv } from "@/lib/setup/database/localServerImage";
import { dataRoot, pgBackRestEnv, scrub } from "./serverHost.mjs";

describe("serverHost", () => {
  it("uses exactly the setup wizard's pgBackRest environment", () => {
    for (const env of [{}, { POLYNOVEA_DATA_ROOT: "/data/p" }]) {
      expect(pgBackRestEnv(env)).toEqual(imagePgBackRestEnv(imagePaths(env)));
      expect(dataRoot(env)).toBe(imagePaths(env).dataRoot);
    }
  });
  it("scrubs connection strings and passwords from program output", () => {
    expect(scrub("a\nFATAL: password authentication failed for postgresql://owner:pw@db:5432/x password=pw\nlast")).toBe("a | FATAL: password authentication failed for [redacted] [redacted] | last");
  });
});
