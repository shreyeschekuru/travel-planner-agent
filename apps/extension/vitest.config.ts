import { defineConfig } from "vitest/config";

// Component tests opt into a DOM with a `@vitest-environment happy-dom` comment.
export default defineConfig({ test: { include: ["test/**/*.test.{ts,tsx}"] } });
