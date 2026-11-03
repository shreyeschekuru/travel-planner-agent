import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Store tests share one Redis when REDIS_URL is set; keep them serial.
    fileParallelism: false,
  },
});
