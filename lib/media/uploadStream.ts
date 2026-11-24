import { Transform, type TransformCallback } from "node:stream";
import { canonicalMediaExtension, assertMediaSignature } from "@/lib/media/uploadValidation";

// Enforces a signed upload's rules on the bytes as they stream through, so a body that breaks them
// never becomes a stored object: exactly `expectedBytes` long (the stream fails as soon as it passes
// the limit, and at the end if it is short) and, for media types we know, starting with that type's
// file signature. Adapters write to a temporary location and only commit when the stream ends cleanly.

export class UploadRejectedError extends Error {
  readonly status: 400 | 413 | 415;
  constructor(message: string, status: 400 | 413 | 415) {
    super(message);
    this.name = "UploadRejectedError";
    this.status = status;
  }
}

const SNIFF_BYTES = 16;

export function enforceUploadRules(expectedBytes: number, contentType: string): Transform {
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes <= 0) throw new UploadRejectedError("Upload size must be a positive integer", 400);
  const sniff = canonicalMediaExtension(contentType) !== null;
  let received = 0;
  let head: Buffer | null = sniff ? Buffer.alloc(0) : null;

  const checkHead = () => {
    if (!head) return;
    try {
      assertMediaSignature(head, contentType);
    } catch {
      throw new UploadRejectedError("Uploaded file content does not match its declared media type", 415);
    }
    head = null;
  };

  return new Transform({
    transform(chunk: Buffer | Uint8Array, _encoding, callback: TransformCallback) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      received += buffer.length;
      if (received > expectedBytes) return callback(new UploadRejectedError("Upload is larger than the size it was signed for", 413));
      try {
        if (head) {
          head = Buffer.concat([head, buffer.subarray(0, SNIFF_BYTES - head.length)]);
          if (head.length >= SNIFF_BYTES) checkHead();
        }
      } catch (error) {
        return callback(error as Error);
      }
      callback(null, buffer);
    },
    flush(callback: TransformCallback) {
      if (received !== expectedBytes) return callback(new UploadRejectedError("Upload is smaller than the size it was signed for", 400));
      try {
        checkHead();
      } catch (error) {
        return callback(error as Error);
      }
      callback();
    },
  });
}

/** The media type of a Content-Type header value, lower-cased, without parameters. */
export function mediaTypeOf(header: string | null | undefined) {
  return (header ?? "").split(";")[0].trim().toLowerCase();
}
