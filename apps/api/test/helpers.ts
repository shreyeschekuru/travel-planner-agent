import { Redis } from "ioredis";
import { afterAll, beforeAll, beforeEach } from "vitest";
import { loadConfig, type Config } from "../src/config.js";
import type { RedisClient } from "../src/store/redis.js";

export const TEST_KEYS =
  "k2:test-secret-k2-xxxxxxxxxxxxxxxxxxxxxxxx,k1:test-secret-k1-xxxxxxxxxxxxxxxxxxxxxxxx";

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";

export function testConfig(overrides: Record<string, string> = {}): Config {
  return loadConfig({
    NODE_ENV: "test",
    REDIS_URL,
    INSTALL_TOKEN_KEYS: TEST_KEYS,
    ...overrides,
  });
}

/**
 * Tests run against a real Redis, on DB 15, flushed before each test so they never
 * touch development data. Start one locally with: docker compose up -d redis
 */
export function useRedis(): () => RedisClient {
  let client: RedisClient | undefined;

  beforeAll(async () => {
    client = new Redis(REDIS_URL, { db: 15, maxRetriesPerRequest: 1, lazyConnect: true });
    try {
      await client.connect();
    } catch {
      throw new Error(
        `Tests need Redis at ${REDIS_URL}. Start it with "docker compose up -d redis" or set REDIS_URL.`,
      );
    }
  });

  beforeEach(async () => {
    await client!.flushdb();
  });

  afterAll(() => {
    client?.disconnect();
  });

  return () => {
    if (!client) throw new Error("useRedis() client used before beforeAll ran");
    return client;
  };
}
