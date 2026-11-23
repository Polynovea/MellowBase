/**
 * Reads the database step's progress: a streamed POST response in server-sent-event format, read
 * with fetch (not EventSource), so the form, including the admin password, travels in the body.
 */

export type StepStatus = "running" | "passed" | "failed";

export type SetupStreamEvent =
  | { type: "check" | "step" | "backup"; id: string; label: string; status: StepStatus; message?: string }
  | { type: "migration"; filename: string; index: number; total: number; status: "running" | "applied" | "skipped" | "failed" }
  | { type: "done"; databaseMode: "local" | "managed" | "created"; restoreTestPending?: boolean }
  | { type: "error"; message: string };

/** Parses complete events out of `buffer`; returns them and the unfinished tail. */
export function parseEventChunk(buffer: string): { events: SetupStreamEvent[]; rest: string } {
  const events: SetupStreamEvent[] = [];
  const parts = buffer.replace(/\r\n/g, "\n").split("\n\n");
  const rest = parts.pop() ?? "";
  for (const part of parts) {
    const data = part.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
    if (!data) continue;
    try {
      events.push(JSON.parse(data) as SetupStreamEvent);
    } catch {
      // A malformed event is skipped; the run's outcome still arrives as done or error.
    }
  }
  return { events, rest };
}

const NETWORK_ERROR = "The connection to the server dropped. The run may still finish on the server: reload this page in a minute to see where it stands.";

/**
 * POSTs to `url` and calls `onEvent` for every event. A response that is not a stream (a refusal such
 * as 401, 409 or 429) becomes one `error` event with the server's plain message.
 */
export async function runSetupStream(url: string, body: unknown, onEvent: (event: SetupStreamEvent) => void, fetchImpl: typeof fetch = fetch): Promise<void> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
      credentials: "same-origin",
      cache: "no-store",
      body: JSON.stringify(body ?? {}),
    });
  } catch {
    onEvent({ type: "error", message: "The server could not be reached. Check your connection and try again." });
    return;
  }
  if (!response.ok || !(response.headers.get("content-type") ?? "").startsWith("text/event-stream") || !response.body) {
    const payload = (await response.json().catch(() => null)) as { error?: string | null } | null;
    onEvent({ type: "error", message: payload?.error || "Something went wrong. Try again." });
    return;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let finished = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parsed = parseEventChunk(buffer);
      buffer = parsed.rest;
      for (const event of parsed.events) {
        if (event.type === "done" || event.type === "error") finished = true;
        onEvent(event);
      }
    }
    const tail = parseEventChunk(`${buffer}${decoder.decode()}\n\n`);
    for (const event of tail.events) {
      if (event.type === "done" || event.type === "error") finished = true;
      onEvent(event);
    }
  } catch {
    // handled below
  }
  if (!finished) onEvent({ type: "error", message: NETWORK_ERROR });
}
