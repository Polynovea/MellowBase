import { describe, expect, it, vi } from "vitest";
import { retryOnConflict } from "@/lib/content/contentMove";

const failure = (code: string) => Object.assign(new Error("content_sync"), { code });

describe("retryOnConflict (backfill batches)", () => {
  it("runs a batch again after a deadlock or a serialization failure, with growing waits", async () => {
    const waits: number[] = [];
    const run = vi.fn()
      .mockRejectedValueOnce(failure("40P01"))
      .mockRejectedValueOnce(failure("40001"))
      .mockResolvedValueOnce("done");
    const retried: string[] = [];
    await expect(retryOnConflict(run, { sleep: async (ms) => { waits.push(ms); }, onRetry: (_, code) => retried.push(code) })).resolves.toBe("done");
    expect(run).toHaveBeenCalledTimes(3);
    expect(retried).toEqual(["40P01", "40001"]);
    // Exponential with jitter: 100 ms x [0.5, 1.5), then 200 ms x [0.5, 1.5).
    expect(waits[0]).toBeGreaterThanOrEqual(50);
    expect(waits[0]).toBeLessThan(150);
    expect(waits[1]).toBeGreaterThanOrEqual(100);
    expect(waits[1]).toBeLessThan(300);
  });

  it("gives up after three retries and throws the last error", async () => {
    const run = vi.fn().mockRejectedValue(failure("40P01"));
    await expect(retryOnConflict(run, { sleep: async () => undefined })).rejects.toMatchObject({ code: "40P01" });
    expect(run).toHaveBeenCalledTimes(4);
  });

  it("never retries other errors", async () => {
    for (const code of ["22P02", "23505", "55000", undefined]) {
      const run = vi.fn().mockRejectedValue(code ? failure(code) : new Error("boom"));
      await expect(retryOnConflict(run, { sleep: async () => undefined })).rejects.toBeTruthy();
      expect(run).toHaveBeenCalledTimes(1);
    }
  });
});
