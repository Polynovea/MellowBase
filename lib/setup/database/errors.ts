import { randomUUID } from "node:crypto";
import { clientErrorMessage } from "@/lib/http/clientError";

/**
 * A failure the wizard shows as written: a plain-language fix, never a driver or server message.
 * `status` 422 marks it as written for the browser, so clientErrorMessage passes it through.
 */
export class DatabaseSetupError extends Error {
  readonly status = 422;
  // Plain fields, not constructor parameter properties: scripts load lib/ through Node's type
  // stripping, which rejects parameter properties (see lib/noParameterProperties.test.ts).
  readonly step: string;
  readonly ref?: string;
  constructor(message: string, step: string, ref?: string) {
    super(ref ? `${message} (ref ${ref})` : message);
    this.name = "DatabaseSetupError";
    this.step = step;
    this.ref = ref;
  }
}

/** Replaces every given secret in `text` with [redacted]. Secrets shorter than 4 characters are ignored. */
export function redact(text: string, secrets: readonly (string | null | undefined)[]): string {
  let out = text;
  for (const secret of secrets) {
    if (typeof secret === "string" && secret.length >= 4) out = out.split(secret).join("[redacted]");
  }
  return out;
}

function describeRaw(error: unknown): string {
  if (error && typeof error === "object") {
    const { name, code, message } = error as { name?: unknown; code?: unknown; message?: unknown };
    return [typeof name === "string" ? name : "Error", typeof code === "string" ? code : "", typeof message === "string" ? message : ""].filter(Boolean).join(" ");
  }
  return String(error);
}

/**
 * Turns a raw failure (driver, socket, server) into the plain fix for the browser. The raw error is
 * logged server-side only, under a reference the user can quote, with any secret still in scope
 * redacted from it first. Only its name, code and message are logged: never the object, which may
 * hold connection settings.
 */
export function setupFailure(step: string, fix: string, raw: unknown, secrets: readonly (string | null | undefined)[] = []): DatabaseSetupError {
  const ref = randomUUID().slice(0, 8);
  console.error("[setup/database] %s failed (ref %s): %s", step, ref, redact(describeRaw(raw), secrets));
  return new DatabaseSetupError(fix, step, ref);
}

/** The message for the browser for anything thrown during the database step. */
export function setupErrorMessage(error: unknown, secrets: readonly (string | null | undefined)[] = []): string {
  if (error instanceof DatabaseSetupError) return clientErrorMessage(error);
  // Unexpected: clientErrorMessage logs it under a reference. Redact first, and pass a plain Error so
  // the logged object carries nothing but the redacted text.
  const safe = new Error(redact(describeRaw(error), secrets));
  safe.name = "DatabaseSetupUnexpectedError";
  Object.assign(safe, { code: "XX000" }); // marks it internal: the fallback text is returned, never this message
  return clientErrorMessage(safe, "The database step failed unexpectedly");
}
