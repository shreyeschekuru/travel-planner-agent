import { keys } from "../store/keys.js";
import type { RedisClient } from "../store/redis.js";

// KEYS[1] bucket hash. ARGV: capacity, refill per second, now (ms).
// Returns {1, 0} when a token was taken, else {0, ms until the next token}.
const TAKE = `
local capacity = tonumber(ARGV[1])
local rate = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local b = redis.call("HMGET", KEYS[1], "tokens", "ts")
local tokens = tonumber(b[1]) or capacity
local ts = tonumber(b[2]) or now
tokens = math.min(capacity, tokens + math.max(0, now - ts) * rate / 1000)
local allowed = 0
local wait = 0
if tokens >= 1 then
  tokens = tokens - 1
  allowed = 1
else
  wait = math.ceil((1 - tokens) * 1000 / rate)
end
redis.call("HSET", KEYS[1], "tokens", tokens, "ts", now)
redis.call("PEXPIRE", KEYS[1], math.ceil(capacity * 1000 / rate) + 1000)
return {allowed, wait}
`;

/**
 * Token bucket shared by all API instances, one per provider. Holds two seconds of tokens by
 * default, so a flex-date search's burst of parallel calls goes through at once.
 */
export class TokenBucket {
  constructor(
    private readonly redis: RedisClient,
    private readonly name: string,
    private readonly perSecond: number,
    private readonly capacity = perSecond * 2,
  ) {}

  async take(now = Date.now()): Promise<{ allowed: boolean; waitMs: number }> {
    const [allowed, waitMs] = (await this.redis.eval(
      TAKE,
      1,
      keys.bucket(this.name),
      String(this.capacity),
      String(this.perSecond),
      String(now),
    )) as [number, number];
    return { allowed: allowed === 1, waitMs };
  }
}
