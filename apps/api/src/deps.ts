import type { Config } from "./config.js";
import { InstallTokens } from "./auth/install-token.js";
import { RateLimiter } from "./limits/rate-limit.js";
import { RedisSemaphore } from "./limits/semaphore.js";
import { SpendGuard } from "./limits/spend.js";
import { LlmClient, createAnthropicMessages, type MessagesApi } from "./llm/client.js";
import { createSearch, type ProviderOverrides } from "./providers/index.js";
import { SessionRunner } from "./orchestrator/run-session.js";
import type { SearchService } from "./search/search.js";
import { Cache } from "./store/cache.js";
import { EventStore } from "./store/events.js";
import type { RedisClient } from "./store/redis.js";
import { SessionStore } from "./store/sessions.js";

export interface Deps {
  config: Config;
  redis: RedisClient;
  tokens: InstallTokens;
  rateLimiter: RateLimiter;
  spend: SpendGuard;
  sessions: SessionStore;
  events: EventStore;
  cache: Cache;
  llm: LlmClient;
  search: SearchService;
  runner: SessionRunner;
  /** How long one XREAD waits before the stream sends a keep-alive comment. */
  sseHeartbeatMs: number;
}

export interface DepsOptions {
  providers?: ProviderOverrides;
  sseHeartbeatMs?: number;
  log?: (err: unknown, msg: string) => void;
  warn?: (data: Record<string, unknown>, msg: string) => void;
}

export function createDeps(
  config: Config,
  redis: RedisClient,
  messages: MessagesApi = createAnthropicMessages(config.ANTHROPIC_API_KEY),
  opts: DepsOptions = {},
): Deps {
  const spend = new SpendGuard(redis, config.LLM_DAILY_SPEND_CAP_USD);
  const cache = new Cache(redis);
  const sessions = new SessionStore(redis);
  const events = new EventStore(redis);
  const search = createSearch(config, redis, cache, opts.providers);
  const llm = new LlmClient({
    messages,
    spend,
    semaphore: new RedisSemaphore(redis, "llm", config.LLM_MAX_CONCURRENCY),
  });
  return {
    config,
    redis,
    tokens: new InstallTokens(config.INSTALL_TOKEN_KEYS),
    rateLimiter: new RateLimiter(redis),
    spend,
    sessions,
    events,
    cache,
    llm,
    search,
    runner: new SessionRunner({
      redis,
      sessions,
      events,
      search,
      llm,
      cache,
      ...(opts.log ? { log: opts.log } : {}),
      ...(opts.warn ? { warn: opts.warn } : {}),
    }),
    sseHeartbeatMs: opts.sseHeartbeatMs ?? 15_000,
  };
}
