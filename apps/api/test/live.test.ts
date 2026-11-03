import { describe, expect, it } from "vitest";
import { z } from "zod";
import { RedisSemaphore } from "../src/limits/semaphore.js";
import { SpendGuard } from "../src/limits/spend.js";
import { LlmClient, createAnthropicMessages } from "../src/llm/client.js";
import { useRedis } from "./helpers.js";

/**
 * Calls the real API (two small Claude Haiku 5.5 requests, well under $0.01).
 * Off by default. Run with: LIVE_LLM_TESTS=1 ANTHROPIC_API_KEY=... npm test -w @travellite/api
 */
const live = process.env.LIVE_LLM_TESTS === "1";

describe.skipIf(!live)("live: prompt caching", () => {
  const redis = useRedis();

  it("serves the stable system prompt from cache on a repeated call", async () => {
    const llm = new LlmClient({
      messages: createAnthropicMessages(process.env.ANTHROPIC_API_KEY),
      spend: new SpendGuard(redis(), 0.05),
      semaphore: new RedisSemaphore(redis(), "llm-live", 1),
    });

    // Must exceed the model's minimum cacheable prefix (512 tokens on Haiku 5.5).
    const rules = Array.from(
      { length: 60 },
      (_, i) => `Rule ${i + 1}: answer travel questions concisely and only from the provided data.`,
    ).join("\n");
    const req = {
      name: "live-cache",
      system: `You are a travel assistant.\n${rules}`,
      input: "Reply with the word ok.",
      schema: z.object({ answer: z.string() }),
      maxTokens: 400,
    };

    const first = await llm.structured(req);
    const second = await llm.structured(req);
    expect(first.ok && second.ok).toBe(true);
    const created = first.usage?.cache_creation_input_tokens ?? 0;
    const read = second.usage?.cache_read_input_tokens ?? 0;
    expect(created + read).toBeGreaterThan(0);
    expect(read).toBeGreaterThan(0);
  }, 60_000);
});
