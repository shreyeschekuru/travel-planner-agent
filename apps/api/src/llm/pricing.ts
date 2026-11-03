export const MODEL = "claude-haiku-5-5" as const;

/** Nano-USD per token. Claude Haiku 5.5: $0.10 / $0.50 per MTok (prompts up to 100K tokens). */
const PRICES = {
  [MODEL]: {
    input: 100,
    output: 500,
    longInput: 500,
    longOutput: 2500,
    longThreshold: 100_000,
    cacheWriteMultiplier: 1.25,
    cacheReadMultiplier: 0.1,
  },
} as const;

export interface UsageLike {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}

export function costNano(model: typeof MODEL, u: UsageLike): number {
  const p = PRICES[model];
  const cacheWrite = u.cache_creation_input_tokens ?? 0;
  const cacheRead = u.cache_read_input_tokens ?? 0;
  const totalIn = u.input_tokens + cacheWrite + cacheRead;
  const long = totalIn > p.longThreshold;
  const inPrice = long ? p.longInput : p.input;
  const outPrice = long ? p.longOutput : p.output;
  return Math.ceil(
    u.input_tokens * inPrice +
      cacheWrite * inPrice * p.cacheWriteMultiplier +
      cacheRead * inPrice * p.cacheReadMultiplier +
      u.output_tokens * outPrice,
  );
}

/** Worst-case cost before a call: rough input estimate (~3 chars/token) + full max_tokens. */
export function estimateNano(model: typeof MODEL, inputChars: number, maxTokens: number): number {
  return costNano(model, { input_tokens: Math.ceil(inputChars / 3), output_tokens: maxTokens });
}
