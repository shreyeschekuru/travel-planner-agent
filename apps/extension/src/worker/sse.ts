import { SessionEvent } from "@travellite/schema";

export interface SseFrame {
  id?: string;
  event?: string;
  data: string;
}

/** Incremental text/event-stream parser. Comment lines (keep-alives) are reported separately. */
export class SseParser {
  private buf = "";

  /** Returns complete frames; `comments` counts keep-alive comments seen. */
  push(chunk: string): { frames: SseFrame[]; comments: number } {
    this.buf += chunk.replace(/\r\n?/g, "\n");
    const frames: SseFrame[] = [];
    let comments = 0;
    let end: number;
    while ((end = this.buf.indexOf("\n\n")) >= 0) {
      const block = this.buf.slice(0, end);
      this.buf = this.buf.slice(end + 2);
      const frame: SseFrame = { data: "" };
      const data: string[] = [];
      let fields = 0;
      for (const line of block.split("\n")) {
        if (line.startsWith(":")) {
          comments++;
          continue;
        }
        const i = line.indexOf(":");
        const name = i < 0 ? line : line.slice(0, i);
        const value = i < 0 ? "" : line.slice(i + 1).replace(/^ /, "");
        fields++;
        if (name === "id") frame.id = value;
        else if (name === "event") frame.event = value;
        else if (name === "data") data.push(value);
      }
      if (fields === 0) continue;
      frame.data = data.join("\n");
      frames.push(frame);
    }
    return { frames, comments };
  }
}

/** Reconnect delays (design.md §5.9); the last one repeats. */
export const BACKOFF_MS = [1000, 2000, 4000, 8000];

export type ConnectionState = "connecting" | "open" | "reconnecting" | "closed";

export interface EventStreamOptions {
  url: string;
  token: () => Promise<string>;
  /** Read before every (re)connect, so a resume starts after the last stored event. */
  lastEventId: () => string | null;
  onEvent: (id: string, event: SessionEvent) => void | Promise<void>;
  onState?: (state: ConnectionState) => void;
  /** Keep-alive comments; the worker touches an extension API so Chrome keeps it running. */
  onPing?: () => void;
  /** The session no longer exists (404) or the token was rejected (401). */
  onGone?: (status: number) => void;
  fetch?: typeof fetch;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

const defaultSleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(t);
      resolve();
    });
  });

/**
 * Keeps an SSE connection open until closed, resuming from the last event ID after any drop.
 * Events are delivered in order; onEvent finishes before the next one is handled.
 */
export function openEventStream(opts: EventStreamOptions): {
  close: () => void;
  done: Promise<void>;
} {
  const controller = new AbortController();
  const fetchFn = opts.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const sleep = opts.sleep ?? defaultSleep;

  async function run() {
    let attempt = 0;
    while (!controller.signal.aborted) {
      opts.onState?.(attempt === 0 ? "connecting" : "reconnecting");
      try {
        const last = opts.lastEventId();
        const res = await fetchFn(opts.url, {
          headers: {
            authorization: `Bearer ${await opts.token()}`,
            accept: "text/event-stream",
            ...(last ? { "last-event-id": last } : {}),
          },
          signal: controller.signal,
        });
        if (res.status === 404 || res.status === 401) {
          opts.onGone?.(res.status);
          break;
        }
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
        opts.onState?.("open");
        const parser = new SseParser();
        const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          const { frames, comments } = parser.push(value);
          if (comments) opts.onPing?.();
          for (const f of frames) {
            if (!f.id || !f.event) continue;
            let data: unknown;
            try {
              data = JSON.parse(f.data);
            } catch {
              continue;
            }
            const parsed = SessionEvent.safeParse({ event: f.event, data });
            if (parsed.success) await opts.onEvent(f.id, parsed.data);
            attempt = 0; // a working stream resets the backoff
          }
        }
      } catch {
        // Network drop or abort; fall through to the backoff below.
      }
      if (controller.signal.aborted) break;
      await sleep(BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)]!, controller.signal);
      attempt++;
    }
    opts.onState?.("closed");
  }

  const done = run();
  return { close: () => controller.abort(), done };
}

/** Compare Redis stream IDs ("ms-seq"). */
export function compareEventIds(a: string, b: string): number {
  const [am = 0, as = 0] = a.split("-").map(Number);
  const [bm = 0, bs = 0] = b.split("-").map(Number);
  return am !== bm ? am - bm : as - bs;
}
