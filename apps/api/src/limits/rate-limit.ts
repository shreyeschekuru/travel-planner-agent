import { keys } from "../store/keys.js";
import type { RedisClient } from "../store/redis.js";

export interface Limit {
  max: number;
  windowSeconds: number;
}

/** Per route group: limits per install token and per client IP. */
export const RATE_LIMITS = {
  install: { ip: { max: 10, windowSeconds: 3600 } },
  prefetch: { token: { max: 120, windowSeconds: 3600 }, ip: { max: 600, windowSeconds: 3600 } },
  sessions: { token: { max: 20, windowSeconds: 3600 }, ip: { max: 100, windowSeconds: 3600 } },
  refine: { token: { max: 60, windowSeconds: 3600 }, ip: { max: 300, windowSeconds: 3600 } },
} satisfies Record<string, { token?: Limit; ip?: Limit }>;
export type RateGroup = keyof typeof RATE_LIMITS;

// INCR the counter; set its expiry on first use. Returns [count, ttl_ms].
const HIT = `
local n = redis.call("INCR", KEYS[1])
if n == 1 then redis.call("PEXPIRE", KEYS[1], ARGV[1]) end
return {n, redis.call("PTTL", KEYS[1])}
`;

export interface RateDecision {
  allowed: boolean;
  retryAfterSeconds: number;
}

/** Fixed-window limiter shared by all API instances through Redis. */
export class RateLimiter {
  constructor(private readonly redis: RedisClient) {}

  async hit(group: string, subject: string, limit: Limit, now = Date.now()): Promise<RateDecision> {
    const windowMs = limit.windowSeconds * 1000;
    const window = Math.floor(now / windowMs);
    const [count, ttl] = (await this.redis.eval(
      HIT,
      1,
      keys.rate(group, subject, window),
      String(windowMs),
    )) as [number, number];
    return {
      allowed: count <= limit.max,
      retryAfterSeconds: Math.max(1, Math.ceil((ttl > 0 ? ttl : windowMs) / 1000)),
    };
  }

  /** Checks every limit for the group; denied if any one is exceeded. */
  async check(
    group: RateGroup,
    subjects: { token?: string; ip: string },
    now = Date.now(),
  ): Promise<RateDecision> {
    const limits: { token?: Limit; ip?: Limit } = RATE_LIMITS[group];
    const checks: Promise<RateDecision>[] = [];
    if (limits.ip) checks.push(this.hit(group, `ip:${subjects.ip}`, limits.ip, now));
    if (limits.token && subjects.token) {
      checks.push(this.hit(group, `tok:${subjects.token}`, limits.token, now));
    }
    const results = await Promise.all(checks);
    const denied = results.filter((r) => !r.allowed);
    return denied.length === 0
      ? { allowed: true, retryAfterSeconds: 0 }
      : { allowed: false, retryAfterSeconds: Math.max(...denied.map((d) => d.retryAfterSeconds)) };
  }
}
