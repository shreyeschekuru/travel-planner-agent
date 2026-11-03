import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { traceable } from "langsmith/traceable";
import { z } from "zod";
import type { RedisSemaphore } from "../limits/semaphore.js";
import { SemaphoreTimeoutError } from "../limits/semaphore.js";
import type { SpendGuard } from "../limits/spend.js";
import { JsonArrayItemSplitter } from "./json-items.js";
import { MODEL, costNano, estimateNano } from "./pricing.js";
import { UNTRUSTED_DATA_RULE } from "./untrusted.js";

export type LlmFailureReason =
  "spend_cap" | "busy" | "refusal" | "max_tokens" | "parse_error" | "api_error";

export interface LlmUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  cost_usd: number;
}

export type LlmResult<T> =
  | { ok: true; value: T; usage: LlmUsage }
  | { ok: false; reason: LlmFailureReason; detail?: string; usage?: LlmUsage };

export interface StructuredRequest<S extends z.ZodType> {
  /** Trace name, e.g. "explain". */
  name: string;
  /** Stable instructions. Kept byte-identical across calls so it is prompt-cached. */
  system: string;
  /** Per-request content. Wrap untrusted parts with wrapData(). */
  input: string;
  schema: S;
  maxTokens: number;
}

export interface StreamItemsRequest<I extends z.ZodType> extends Omit<
  StructuredRequest<I>,
  "schema"
> {
  itemSchema: I;
  onItem: (item: z.infer<I>) => void | Promise<void>;
}

/** The subset of the SDK this client uses; lets tests inject a fake. */
export type MessagesApi = Pick<Anthropic["messages"], "parse" | "stream">;

export interface LlmClientDeps {
  messages: MessagesApi;
  spend: SpendGuard;
  semaphore: RedisSemaphore;
  semaphoreTimeoutMs?: number;
}

export function createAnthropicMessages(apiKey?: string): MessagesApi {
  // One SDK retry; no application-level LLM retries (see design.md §5.5).
  return new Anthropic({ ...(apiKey ? { apiKey } : {}), maxRetries: 1 }).messages;
}

type RawUsage = {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
};

function toUsage(u: RawUsage): LlmUsage {
  return {
    input_tokens: u.input_tokens,
    output_tokens: u.output_tokens,
    cache_creation_input_tokens: u.cache_creation_input_tokens ?? 0,
    cache_read_input_tokens: u.cache_read_input_tokens ?? 0,
    cost_usd: costNano(MODEL, u) / 1e9,
  };
}

export class LlmClient {
  constructor(private readonly deps: LlmClientDeps) {}

  private systemBlocks(system: string) {
    return [
      {
        type: "text" as const,
        text: `${system}\n\n${UNTRUSTED_DATA_RULE}`,
        cache_control: { type: "ephemeral" as const },
      },
    ];
  }

  /** Spend reservation + concurrency slot around one call; always settles the reservation. */
  private async guarded<T>(
    req: { system: string; input: string; maxTokens: number },
    call: () => Promise<{ result: LlmResult<T>; raw?: RawUsage }>,
  ): Promise<LlmResult<T>> {
    const reservation = await this.deps.spend.reserve(
      estimateNano(MODEL, req.system.length + req.input.length, req.maxTokens),
    );
    if (!reservation) return { ok: false, reason: "spend_cap" };

    let actualNano = 0;
    try {
      const release = await this.deps.semaphore.acquire(this.deps.semaphoreTimeoutMs ?? 5_000);
      try {
        const { result, raw } = await call();
        if (raw) actualNano = costNano(MODEL, raw);
        return result;
      } finally {
        await release();
      }
    } catch (err) {
      if (err instanceof SemaphoreTimeoutError) return { ok: false, reason: "busy" };
      if (err instanceof Anthropic.APIError) {
        return { ok: false, reason: "api_error", detail: `status ${err.status ?? "unknown"}` };
      }
      throw err;
    } finally {
      await this.deps.spend.settle(reservation, actualNano);
    }
  }

  /** One structured-output call. Returns a typed failure instead of throwing for API problems. */
  structured<S extends z.ZodType>(req: StructuredRequest<S>): Promise<LlmResult<z.infer<S>>> {
    const run = traceable(
      async (r: StructuredRequest<S>) =>
        this.guarded<z.infer<S>>(r, async () => {
          const msg = await this.deps.messages.parse({
            model: MODEL,
            max_tokens: r.maxTokens,
            system: this.systemBlocks(r.system),
            messages: [{ role: "user", content: r.input }],
            output_config: { effort: "low", format: zodOutputFormat(r.schema) },
          });
          const usage = toUsage(msg.usage);
          if (msg.stop_reason === "refusal")
            return { result: { ok: false, reason: "refusal", usage }, raw: msg.usage };
          if (msg.stop_reason === "max_tokens")
            return { result: { ok: false, reason: "max_tokens", usage }, raw: msg.usage };
          const parsed = r.schema.safeParse(msg.parsed_output);
          if (!parsed.success)
            return { result: { ok: false, reason: "parse_error", usage }, raw: msg.usage };
          return { result: { ok: true, value: parsed.data, usage }, raw: msg.usage };
        }),
      { name: `llm.${req.name}`, run_type: "llm" },
    );
    return run(req);
  }

  /**
   * Streams a response shaped {"items":[...]} and calls onItem for each complete,
   * schema-valid item as it arrives. Resolves with the final validated list.
   */
  streamItems<I extends z.ZodType>(req: StreamItemsRequest<I>): Promise<LlmResult<z.infer<I>[]>> {
    const wrapper = z.object({ items: z.array(req.itemSchema) });
    const run = traceable(
      async (r: StreamItemsRequest<I>) =>
        this.guarded<z.infer<I>[]>(r, async () => {
          const stream = this.deps.messages.stream({
            model: MODEL,
            max_tokens: r.maxTokens,
            system: this.systemBlocks(r.system),
            messages: [{ role: "user", content: r.input }],
            output_config: { effort: "low", format: zodOutputFormat(wrapper) },
          });
          const splitter = new JsonArrayItemSplitter();
          for await (const ev of stream) {
            if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") {
              for (const raw of splitter.push(ev.delta.text)) {
                const item = r.itemSchema.safeParse(raw);
                if (item.success) await r.onItem(item.data);
              }
            }
          }
          const msg = await stream.finalMessage();
          const usage = toUsage(msg.usage);
          if (msg.stop_reason === "refusal")
            return { result: { ok: false, reason: "refusal", usage }, raw: msg.usage };
          if (msg.stop_reason === "max_tokens")
            return { result: { ok: false, reason: "max_tokens", usage }, raw: msg.usage };
          const parsed = wrapper.safeParse(msg.parsed_output);
          if (!parsed.success)
            return { result: { ok: false, reason: "parse_error", usage }, raw: msg.usage };
          return { result: { ok: true, value: parsed.data.items, usage }, raw: msg.usage };
        }),
      { name: `llm.${req.name}`, run_type: "llm" },
    );
    return run(req);
  }
}
