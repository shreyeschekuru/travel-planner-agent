import { randomUUID } from "node:crypto";
import { keys } from "../store/keys.js";
import type { RedisClient } from "../store/redis.js";

// Drop expired leases, then take a slot if one is free. Returns 1 on success.
const ACQUIRE = `
redis.call("ZREMRANGEBYSCORE", KEYS[1], "-inf", ARGV[1])
if redis.call("ZCARD", KEYS[1]) < tonumber(ARGV[2]) then
  redis.call("ZADD", KEYS[1], ARGV[3], ARGV[4])
  redis.call("PEXPIRE", KEYS[1], ARGV[5])
  return 1
end
return 0
`;

export class SemaphoreTimeoutError extends Error {
  constructor(name: string) {
    super(`Timed out waiting for semaphore "${name}"`);
  }
}

/**
 * Counting semaphore shared across instances. Leases expire, so a crashed holder
 * can't block the slot forever.
 */
export class RedisSemaphore {
  constructor(
    private readonly redis: RedisClient,
    private readonly name: string,
    private readonly limit: number,
    private readonly leaseMs = 60_000,
  ) {}

  async acquire(timeoutMs = 10_000): Promise<() => Promise<void>> {
    const key = keys.semaphore(this.name);
    const holder = randomUUID();
    const deadline = Date.now() + timeoutMs;
    let delay = 25;
    for (;;) {
      const now = Date.now();
      const ok = (await this.redis.eval(
        ACQUIRE,
        1,
        key,
        String(now),
        String(this.limit),
        String(now + this.leaseMs),
        holder,
        String(this.leaseMs * 2),
      )) as number;
      if (ok === 1) {
        return async () => {
          await this.redis.zrem(key, holder);
        };
      }
      if (Date.now() + delay > deadline) throw new SemaphoreTimeoutError(this.name);
      await new Promise((r) => setTimeout(r, delay + Math.random() * delay));
      delay = Math.min(delay * 2, 500);
    }
  }

  async run<T>(fn: () => Promise<T>, timeoutMs?: number): Promise<T> {
    const release = await this.acquire(timeoutMs);
    try {
      return await fn();
    } finally {
      await release();
    }
  }
}
