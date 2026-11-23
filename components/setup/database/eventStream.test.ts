import { describe, expect, it } from "vitest";
import { parseEventChunk, runSetupStream, type SetupStreamEvent } from "./eventStream";

const sse = (events: object[]) => events.map((event) => `event: ${(event as { type: string }).type}\ndata: ${JSON.stringify(event)}\n\n`).join("");

function streamResponse(text: string, chunkSize = 7): Response {
  const bytes = new TextEncoder().encode(text);
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < bytes.length; i += chunkSize) controller.enqueue(bytes.slice(i, i + chunkSize));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream; charset=utf-8" } });
}

describe("parseEventChunk", () => {
  it("returns complete events and keeps the unfinished tail", () => {
    const text = sse([{ type: "check", id: "dns", label: "x", status: "running" }]) + 'event: check\ndata: {"type":"ch';
    const { events, rest } = parseEventChunk(text);
    expect(events).toEqual([{ type: "check", id: "dns", label: "x", status: "running" }]);
    expect(rest).toBe('event: check\ndata: {"type":"ch');
  });
});

describe("runSetupStream", () => {
  it("delivers every event across arbitrary chunk boundaries, sending the form in a POST body", async () => {
    const sent: RequestInit[] = [];
    const events: SetupStreamEvent[] = [];
    const body = sse([
      { type: "check", id: "dns", label: "Finding the database", status: "passed" },
      { type: "migration", filename: "0001_a.sql", index: 1, total: 2, status: "applied" },
      { type: "done", databaseMode: "managed" },
    ]);
    await runSetupStream("/api/setup/database/managed", { password: "pw" }, (event) => events.push(event), (async (_url: string, init: RequestInit) => {
      sent.push(init);
      return streamResponse(body);
    }) as typeof fetch);
    expect(events.map((event) => event.type)).toEqual(["check", "migration", "done"]);
    expect(sent[0]).toMatchObject({ method: "POST", credentials: "same-origin", body: JSON.stringify({ password: "pw" }) });
  });

  it("turns a refusal into one error event with the server's message", async () => {
    const events: SetupStreamEvent[] = [];
    await runSetupStream("/x", {}, (event) => events.push(event), (async () => Response.json({ error: "Setup is already running." }, { status: 409 })) as typeof fetch);
    expect(events).toEqual([{ type: "error", message: "Setup is already running." }]);
  });

  it("reports a stream that ends without an outcome", async () => {
    const events: SetupStreamEvent[] = [];
    await runSetupStream("/x", {}, (event) => events.push(event), (async () => streamResponse(sse([{ type: "check", id: "dns", label: "x", status: "running" }]))) as typeof fetch);
    expect(events.at(-1)).toMatchObject({ type: "error", message: expect.stringMatching(/connection to the server dropped/) });
  });
});
