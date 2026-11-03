import type { Config } from "./config.js";
import { InstallTokens } from "./auth/install-token.js";
import { RateLimiter } from "./limits/rate-limit.js";
import { RedisSemaphore } from "./limits/semaphore.js";
import { SpendGuard } from "./limits/spend.js";
import { LlmClient, createAnthropicMessages, type MessagesApi } from "./llm/client.js";
import { createSearch, type ProviderOverrides } from "./providers/index.js";
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
}

export function createDeps(
  config: Config,
  redis: RedisClient,
  messages: MessagesApi = createAnthropicMessages(config.ANTHROPIC_API_KEY),
  providers: ProviderOverrides = {},
): Deps {
  const spend = new SpendGuard(redis, config.LLM_DAILY_SPEND_CAP_USD);
  const cache = new Cache(redis);
  return {
    config,
    redis,
    tokens: new InstallTokens(config.INSTALL_TOKEN_KEYS),
    rateLimiter: new RateLimiter(redis),
    spend,
    sessions: new SessionStore(redis),
    events: new EventStore(redis),
    cache,
    llm: new LlmClient({
      messages,
      spend,
      semaphore: new RedisSemaphore(redis, "llm", config.LLM_MAX_CONCURRENCY),
    }),
    search: createSearch(config, redis, cache, providers),
  };
}
