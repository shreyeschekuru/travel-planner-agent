import { describe, expect, it, vi } from "vitest";
import { BACKOFF_MS, SseParser, compareEventIds, openEventStream } from "../src/worker/sse.js";

describe("SseParser", () => {
  it("handles frames split across chunks, CRLF and comments", () => {
    const p = new SseParser();
    expect(p.push("id: 1-0\nevent: results\nda").frames).toEqual([]);
    const r = p.push('ta: {"a":1}\r\n\r\n: keep-alive\n\nid: 2-0\nevent: x\ndata: a\ndata: b\n\n');
    expect(r.frames).toEqual([
      { id: "1-0", event: "results", data: '{"a":1}' },
      { id: "2-0", event: "x", data: "a\nb" },
    ]);
    expect(r.comments).toBe(1);
  });
});

describe("compareEventIds", () => {
  it("orders by time, then sequence", () => {
    expect(compareEventIds("10-1", "9-5")).toBeGreaterThan(0);
    expect(compareEventIds("10-1", "10-2")).toBeLessThan(0);
    expect(compareEventIds("10-2", "10-2")).toBe(0);
  });
});

const frame = (id: string, event: string, data: unknown) =>
  `id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

function streamResponse(chunks: string[], status = 200) {
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      for (const ch of chunks) c.enqueue(new TextEncoder().encode(ch));
      c.close();
    },
  });
  return new Response(body, { status, headers: { "content-type": "text/event-stream" } });
}

describe("openEventStream", () => {
  it("delivers valid events in order, resumes from the last ID and backs off 1, 2, 4, 8, 8 s", async () => {
    let last: string | null = null;
    const seen: string[] = [];
    const sleeps: number[] = [];
    const headers: (string | null)[] = [];
    let call = 0;
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      headers.push(new Headers(init?.headers).get("last-event-id"));
      call++;
      if (call === 1) {
        return streamResponse([
          frame("1-0", "results", { category: "flight", count: 10 }),
          frame("2-0", "bogus", { x: 1 }),
          frame("3-0", "results", { category: "hotel", count: 9 }),
        ]);
      }
      if (call <= 6) throw new TypeError("network down");
      return new Response(null, { status: 404 });
    });
    const onGone = vi.fn();
    const handle = openEventStream({
      url: "http://api/v1/sessions/s/events",
      token: async () => "tok",
      lastEventId: () => last,
      onEvent: (id, e) => {
        last = id;
        seen.push(`${id}:${e.event}`);
      },
      onGone,
      fetch: fetch as unknown as typeof globalThis.fetch,
      sleep: async (ms) => void sleeps.push(ms),
    });
    await handle.done;
    expect(seen).toEqual(["1-0:results", "3-0:results"]);
    expect(headers).toEqual([null, "3-0", "3-0", "3-0", "3-0", "3-0", "3-0"]);
    // After the first (working) stream ends: 1 s, then failures back off 2, 4, 8, 8, 8.
    expect(sleeps).toEqual([BACKOFF_MS[0], 2000, 4000, 8000, 8000, 8000]);
    expect(onGone).toHaveBeenCalledWith(404);
  });

  it("sends the install token and stops when closed", async () => {
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer tok");
      return new Promise<Response>((_, reject) =>
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        ),
      );
    });
    const states: string[] = [];
    const handle = openEventStream({
      url: "http://api/x",
      token: async () => "tok",
      lastEventId: () => null,
      onEvent: () => {},
      onState: (s) => states.push(s),
      fetch: fetch as unknown as typeof globalThis.fetch,
    });
    await new Promise((r) => setTimeout(r, 0));
    handle.close();
    await handle.done;
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(states).toEqual(["connecting", "closed"]);
  });

  it("reports keep-alive comments", async () => {
    const onPing = vi.fn();
    let n = 0;
    const handle = openEventStream({
      url: "http://api/x",
      token: async () => "t",
      lastEventId: () => null,
      onEvent: () => {},
      onPing,
      fetch: (async () =>
        ++n === 1
          ? streamResponse([": keep-alive\n\n"])
          : new Response(null, { status: 404 })) as never,
      sleep: async () => {},
    });
    await handle.done;
    expect(onPing).toHaveBeenCalledTimes(1);
  });
});
