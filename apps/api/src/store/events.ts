import { SESSION_TTL_SECONDS, SessionEvent } from "@travellite/schema";
import { keys } from "./keys.js";
import type { RedisClient } from "./redis.js";

export interface StoredEvent {
  id: string;
  event: SessionEvent;
}

type StreamEntries = [id: string, fields: string[]][];

/** Compare Redis stream IDs ("ms-seq"). */
export function compareStreamIds(a: string, b: string): number {
  const [am = 0, as = 0] = a.split("-").map(Number);
  const [bm = 0, bs = 0] = b.split("-").map(Number);
  return am !== bm ? am - bm : as - bs;
}

/** Decode entries strictly after `afterId`; invalid entries are skipped. */
function decode(entries: StreamEntries | null | undefined, afterId: string): StoredEvent[] {
  if (!entries) return [];
  const out: StoredEvent[] = [];
  for (const [id, fields] of entries) {
    if (afterId !== "0" && compareStreamIds(id, afterId) <= 0) continue;
    const i = fields.indexOf("e");
    const raw = i >= 0 ? fields[i + 1] : undefined;
    if (!raw) continue;
    const parsed = SessionEvent.safeParse(JSON.parse(raw));
    if (parsed.success) out.push({ id, event: parsed.data });
  }
  return out;
}

/**
 * Append-only event log per session (Redis Stream). Every emitted event is stored, so a
 * client can reconnect to any instance and resume from its Last-Event-ID without loss.
 */
export class EventStore {
  constructor(
    private readonly redis: RedisClient,
    private readonly ttlSeconds = SESSION_TTL_SECONDS,
  ) {}

  async append(sessionId: string, event: SessionEvent): Promise<string> {
    const valid = SessionEvent.parse(event);
    const key = keys.events(sessionId);
    const id = await this.redis.xadd(key, "*", "e", JSON.stringify(valid));
    await this.redis.expire(key, this.ttlSeconds);
    if (!id) throw new Error("XADD returned no id");
    return id;
  }

  /** Events strictly after `afterId` ("0" = from the start). */
  async readAfter(sessionId: string, afterId = "0", count = 500): Promise<StoredEvent[]> {
    // Inclusive start, then drop afterId itself: portable across Redis versions.
    const start = afterId === "0" ? "-" : afterId;
    const entries = (await this.redis.xrange(
      keys.events(sessionId),
      start,
      "+",
      "COUNT",
      count + 1,
    )) as StreamEntries;
    return decode(entries, afterId).slice(0, count);
  }

  /**
   * Wait up to `blockMs` for events after `afterId`. Returns [] on timeout.
   * Uses a dedicated connection because XREAD BLOCK holds it.
   */
  async tail(
    blocking: RedisClient,
    sessionId: string,
    afterId: string,
    blockMs: number,
  ): Promise<StoredEvent[]> {
    const res = (await blocking.xread(
      "BLOCK",
      blockMs,
      "STREAMS",
      keys.events(sessionId),
      afterId,
    )) as [key: string, entries: StreamEntries][] | null;
    return decode(res?.[0]?.[1], afterId);
  }

  async delete(sessionId: string): Promise<void> {
    await this.redis.del(keys.events(sessionId));
  }
}
