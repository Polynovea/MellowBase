import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { imagePaths, imagePgBackRestEnv } from "@/lib/setup/database/localServerImage";
import { dataRoot, pgBackRestEnv, restoreCommand, scrub } from "./serverHost.mjs";

describe("serverHost", () => {
  it("uses exactly the setup wizard's pgBackRest environment", () => {
    expect(pgBackRestEnv()).toEqual(imagePgBackRestEnv(imagePaths()));
    expect(dataRoot()).toBe(imagePaths().dataRoot);
  });

  it("fetches WAL with the same settings as the image's archive_command", () => {
    const archive = /archive_command = '(.*)'/.exec(readFileSync("docker/local-db.sh", "utf8"))![1]
      .replace('"$PGBACKREST_CONFIG"', '"/var/lib/polynovea/etc/pgbackrest.conf"')
      .replace('"$LOG_DIR/pgbackrest"', '"/var/lib/polynovea/log/pgbackrest"');
    expect(restoreCommand()).toBe(archive.replace('archive-push "%p"', 'archive-get %f "%p"'));
  });

  it("scrubs connection strings and passwords from program output", () => {
    expect(scrub("a\nFATAL: password authentication failed for postgresql://owner:pw@db:5432/x password=pw\nlast")).toBe("a | FATAL: password authentication failed for [redacted] [redacted] | last");
  });
});
