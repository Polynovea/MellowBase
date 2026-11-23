import type { CheckEvent } from "./checks";
import { redact, setupErrorMessage } from "./errors";
import type { MigrationEvent } from "./migrate";
import type { ProvisionEvent } from "./provision";

/**
 * Live progress for the database step: one streamed POST response (`text/event-stream`, read by the
 * page with fetch, not EventSource, so the form, including the admin password, travels in the body
 * and never in a URL). One event per check, per provisioning step and per migration.
 *
 * The admin password lives only in the request's scope. `secrets()` returns what is still held, and
 * every event is redacted against it before it is written: a guard, since no event is built from it.
 */

export type BackupEvent = { type: "backup"; id: string; label: string; status: "running" | "passed" | "failed"; message?: string };
export type DoneEvent = { type: "done"; databaseMode: "local" | "managed" | "created"; restoreTestPending?: boolean };
export type ErrorEvent = { type: "error"; message: string };
export type SetupEvent = CheckEvent | ProvisionEvent | MigrationEvent | BackupEvent | DoneEvent | ErrorEvent;

export function formatEvent(event: SetupEvent, secrets: readonly (string | null | undefined)[] = []): string {
  return `event: ${event.type}\ndata: ${redact(JSON.stringify(event), secrets)}\n\n`;
}

export interface StreamOptions {
  /** Secrets still in scope (the admin password until the roles exist). */
  secrets?: () => readonly (string | null | undefined)[];
  /** Runs once the stream has finished, whatever the outcome (releases the concurrency slot). */
  onFinish?: () => void;
}

/**
 * Streams the events `run` emits. A failure becomes one final `error` event with the plain message
 * (through clientErrorMessage); the HTTP status stays 200 because the stream has already started.
 */
export function setupEventStream(run: (emit: (event: SetupEvent) => void) => Promise<void>, options: StreamOptions = {}): Response {
  const encoder = new TextEncoder();
  const secrets = options.secrets ?? (() => []);
  let closed = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const write = (event: SetupEvent) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(formatEvent(event, secrets())));
        } catch {
          closed = true; // the browser went away; the run carries on to a consistent end
        }
      };
      void (async () => {
        try {
          await run(write);
        } catch (error) {
          write({ type: "error", message: setupErrorMessage(error, secrets()) });
        } finally {
          if (!closed) {
            closed = true;
            try {
              controller.close();
            } catch {
              // already closed by the browser
            }
          }
          options.onFinish?.();
        }
      })();
    },
    cancel() {
      closed = true;
    },
  });
  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      "X-Accel-Buffering": "no",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

/**
 * At most `maxConcurrent` database-step streams on the server, and one per setup session. Each run
 * opens sockets to a database and may run DDL, so this caps what one leaked setup code can do.
 */
export function createStreamLimiter(maxConcurrent = 2) {
  const active = new Set<string>();
  return {
    acquire(sessionId: string): (() => void) | null {
      if (active.has(sessionId) || active.size >= maxConcurrent) return null;
      active.add(sessionId);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        active.delete(sessionId);
      };
    },
    get size() {
      return active.size;
    },
  };
}

/** Database-step runs per setup session: `max` within `windowMs`. */
export function createRunRateLimiter(max = 10, windowMs = 10 * 60_000, now: () => number = Date.now) {
  const runs = new Map<string, number[]>();
  return {
    /** Records a run and returns true, or returns false when the session is over its limit. */
    allow(sessionId: string): boolean {
      const cutoff = now() - windowMs;
      const recent = (runs.get(sessionId) ?? []).filter((at) => at > cutoff);
      if (recent.length >= max) {
        runs.set(sessionId, recent);
        return false;
      }
      recent.push(now());
      runs.set(sessionId, recent);
      // Keep the map small: forget sessions with nothing recent.
      for (const [key, times] of runs) if (key !== sessionId && times.every((at) => at <= cutoff)) runs.delete(key);
      return true;
    },
  };
}

/** Shared by the database-step routes. */
export const databaseStreams = createStreamLimiter(2);
export const databaseRuns = createRunRateLimiter(10, 10 * 60_000);
