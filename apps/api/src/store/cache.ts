import { Option } from "@travellite/schema";
import { keys } from "./keys.js";
import type { RedisClient } from "./redis.js";

/** JSON cache with TTL, plus option-by-ID storage so sessions can hold IDs only. */
export class Cache {
  constructor(private readonly redis: RedisClient) {}

  async getJson<T>(name: string): Promise<T | null> {
    const raw = await this.redis.get(keys.cache(name));
    return raw ? (JSON.parse(raw) as T) : null;
  }

  async setJson(name: string, value: unknown, ttlSeconds: number): Promise<void> {
    await this.redis.set(keys.cache(name), JSON.stringify(value), "EX", ttlSeconds);
  }

  async putOptions(options: Option[], ttlSeconds: number): Promise<void> {
    if (options.length === 0) return;
    const pipeline = this.redis.pipeline();
    for (const o of options) {
      pipeline.set(keys.option(o.id), JSON.stringify(Option.parse(o)), "EX", ttlSeconds);
    }
    await pipeline.exec();
  }

  async getOptions(ids: string[]): Promise<Map<string, Option>> {
    const out = new Map<string, Option>();
    if (ids.length === 0) return out;
    const raws = await this.redis.mget(ids.map(keys.option));
    raws.forEach((raw, i) => {
      if (!raw) return;
      const parsed = Option.safeParse(JSON.parse(raw));
      const id = ids[i];
      if (parsed.success && id) out.set(id, parsed.data);
    });
    return out;
  }
}
