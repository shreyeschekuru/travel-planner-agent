import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createDeps } from "./deps.js";
import { createRedis } from "./store/redis.js";

const config = loadConfig();
const redis = createRedis(config.REDIS_URL);
const deps = createDeps(config, redis, undefined, {
  log: (err, msg) => app.log.error({ err }, msg),
});
const app = await buildApp(deps, {
  logger: true,
  trustProxy: config.NODE_ENV === "production",
});

const SHUTDOWN_GRACE_MS = 10_000;
const shutdown = async () => {
  // Event streams are ended by a preClose hook; the timeout covers anything else left open.
  await Promise.race([app.close(), new Promise((r) => setTimeout(r, SHUTDOWN_GRACE_MS))]);
  // Let background prefetches finish writing to the cache, but don't hang on them.
  // Unfinished session runs are picked up again by recover() on the next start.
  await Promise.race([
    Promise.all([deps.search.idle(), deps.runner.idle()]),
    new Promise((r) => setTimeout(r, 5000)),
  ]);
  redis.disconnect();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

await app.listen({ port: config.PORT, host: "0.0.0.0" });
const recovered = await deps.runner.recover();
if (recovered) app.log.info({ recovered }, "restarted interrupted sessions");
