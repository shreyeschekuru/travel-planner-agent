import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createDeps } from "./deps.js";
import { createRedis } from "./store/redis.js";

const config = loadConfig();
const redis = createRedis(config.REDIS_URL);
const deps = createDeps(config, redis);
const app = await buildApp(deps, {
  logger: true,
  trustProxy: config.NODE_ENV === "production",
});

const shutdown = async () => {
  await app.close();
  // Let background prefetches finish writing to the cache, but don't hang on them.
  await Promise.race([deps.search.idle(), new Promise((r) => setTimeout(r, 5000))]);
  redis.disconnect();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

await app.listen({ port: config.PORT, host: "0.0.0.0" });
