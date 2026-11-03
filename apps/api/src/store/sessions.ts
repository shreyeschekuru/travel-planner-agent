import { SESSION_TTL_SECONDS, SessionRecord } from "@travellite/schema";
import { keys } from "./keys.js";
import type { RedisClient } from "./redis.js";

export class SessionStore {
  constructor(
    private readonly redis: RedisClient,
    private readonly ttlSeconds = SESSION_TTL_SECONDS,
  ) {}

  async get(id: string): Promise<SessionRecord | null> {
    const raw = await this.redis.get(keys.session(id));
    if (!raw) return null;
    const parsed = SessionRecord.safeParse(JSON.parse(raw));
    // A record that no longer matches the schema is treated as missing, not trusted.
    return parsed.success ? parsed.data : null;
  }

  /** Validates before writing. Refreshes the TTL on every write. */
  async put(record: SessionRecord): Promise<void> {
    const valid = SessionRecord.parse(record);
    await this.redis.set(keys.session(valid.id), JSON.stringify(valid), "EX", this.ttlSeconds);
  }

  /** Fetch only if the session belongs to this install; otherwise behaves as not found. */
  async getOwned(id: string, installId: string): Promise<SessionRecord | null> {
    const record = await this.get(id);
    return record && record.install_id === installId ? record : null;
  }

  async delete(id: string): Promise<void> {
    await this.redis.del(keys.session(id));
  }
}
