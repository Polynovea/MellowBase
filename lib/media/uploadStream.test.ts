import { Readable } from "node:stream";
import { buffer } from "node:stream/consumers";
import { describe, expect, it } from "vitest";
import { enforceUploadRules, mediaTypeOf, UploadRejectedError } from "@/lib/media/uploadStream";

const png = (size: number) => Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(Math.max(0, size - 8), 1)]);

function run(chunks: Buffer[], expected: number, type: string) {
  return buffer(Readable.from(chunks).pipe(enforceUploadRules(expected, type)));
}

async function rejection(promise: Promise<unknown>) {
  const error = await promise.then(() => null, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(UploadRejectedError);
  return error as UploadRejectedError;
}

describe("signed upload stream rules", () => {
  it("passes a body of exactly the signed size and type, across chunk boundaries", async () => {
    const body = png(100);
    const out = await run([body.subarray(0, 3), body.subarray(3, 40), body.subarray(40)], 100, "image/png");
    expect(out.equals(body)).toBe(true);
  });

  it("stops a body that grows past the signed size", async () => {
    expect((await rejection(run([png(64), Buffer.alloc(64)], 100, "image/png"))).status).toBe(413);
  });

  it("refuses a body shorter than the signed size", async () => {
    expect((await rejection(run([png(50)], 100, "image/png"))).status).toBe(400);
  });

  it("refuses bytes that are not the declared media type", async () => {
    const html = Buffer.from("<html><script>alert(1)</script></html>");
    expect((await rejection(run([html], html.length, "image/png"))).status).toBe(415);
    const tiny = Buffer.from("GIF");
    expect((await rejection(run([tiny], 3, "image/gif"))).status).toBe(415);
  });

  it("does not sniff types it has no signature for", async () => {
    const pdf = Buffer.from("%PDF-1.7 anything");
    expect((await run([pdf], pdf.length, "application/pdf")).length).toBe(pdf.length);
  });

  it("refuses a non-positive signed size", () => {
    expect(() => enforceUploadRules(0, "image/png")).toThrow(UploadRejectedError);
  });

  it("normalises Content-Type headers", () => {
    expect(mediaTypeOf("Image/PNG; charset=binary")).toBe("image/png");
    expect(mediaTypeOf(null)).toBe("");
  });
});
