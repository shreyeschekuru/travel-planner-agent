import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createDeps } from "./deps.js";
import { createRedis } from "./store/redis.js";

const config = loadConfig();
const redis = createRedis(config.REDIS_URL);
const app = await buildApp(createDeps(config, redis), {
  logger: true,
  trustProxy: config.NODE_ENV === "production",
});

const shutdown = async () => {
  await app.close();
  redis.disconnect();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

await app.listen({ port: config.PORT, host: "0.0.0.0" });
