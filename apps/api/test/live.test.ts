import { describe, expect, it } from "vitest";
import { z } from "zod";
import { RedisSemaphore } from "../src/limits/semaphore.js";
import { SpendGuard } from "../src/limits/spend.js";
import { applyDelta } from "../src/core/deltas.js";
import { LlmClient, createAnthropicMessages } from "../src/llm/client.js";
import { parseDelta } from "../src/llm/parse-delta.js";
import { useRedis } from "./helpers.js";
import { canonical, loadParseDeltaEval } from "./parse-delta-eval.js";

/**
 * Calls the real API (small Claude Haiku 5.5 requests, well under $0.02 in all).
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

/**
 * The parse-delta eval set (evals/parse-delta.json) against the real model: 17 small calls,
 * well under $0.01. Graded on the resulting constraints.
 */
describe.skipIf(!live)("live: parse-delta eval", () => {
  const redis = useRedis();

  it("maps the sample phrases to the expected constraints", async () => {
    const llm = new LlmClient({
      messages: createAnthropicMessages(process.env.ANTHROPIC_API_KEY),
      spend: new SpendGuard(redis(), 0.1),
      semaphore: new RedisSemaphore(redis(), "llm-live", 4),
    });
    const set = loadParseDeltaEval();
    const misses: string[] = [];
    for (const c of set.cases) {
      const parsed = await parseDelta(llm, c.text, set.constraints, set.context);
      const applied = parsed.ok ? applyDelta(set.constraints, parsed.delta) : null;
      const got = applied?.ok ? applied.constraints : null;
      const pass = c.expected
        ? got !== null && canonical(got) === canonical(c.expected)
        : !parsed.ok;
      if (!pass)
        misses.push(`${c.text} -> ${parsed.ok ? JSON.stringify(parsed.delta.ops) : parsed.reason}`);
    }
    if (misses.length) console.log(`parse-delta misses:\n${misses.join("\n")}`);
    // Allow two misses while the prompt is tuned; the eval suite (T5.2) tracks the trend.
    expect(misses.length).toBeLessThanOrEqual(2);
  }, 120_000);
});
