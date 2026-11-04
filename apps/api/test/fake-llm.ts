import { vi } from "vitest";
import type { MessagesApi } from "../src/llm/client.js";
import type { CompactPackage } from "../src/llm/explain-input.js";

const usage = {
  input_tokens: 1500,
  output_tokens: 400,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 900,
};

/** Reads the packages back out of the explain prompt's <data name="packages"> block. */
export function promptPackages(params: { messages: { content: unknown }[] }): CompactPackage[] {
  const content = String(params.messages[0]?.content ?? "");
  const m = /<data name="packages">\n(.*)\n<\/data>/s.exec(content);
  return m ? (JSON.parse(m[1]!) as CompactPackage[]) : [];
}

export type ExplainBehavior = "grounded" | "hallucinated" | "refusal" | "throws";

/** A fake Messages API whose stream answers the explain prompt. */
export function fakeExplainLlm(behavior: ExplainBehavior = "grounded") {
  const stream = vi.fn((params: { messages: { content: unknown }[] }) => {
    if (behavior === "throws") throw new Error("socket hang up");
    const items = promptPackages(params).map((p) => ({
      package_id: p.id,
      headline: `${p.label}: ${p.ht.name}`.slice(0, 80),
      pros: [
        {
          text: `Total $${p.total.toLocaleString("en-US")} for the trip`,
          source_fields: ["total"],
        },
        behavior === "hallucinated"
          ? { text: "Free breakfast worth $45 a day", source_fields: ["ht.price"] }
          : { text: `${p.fl.stops} stops, ${p.fl.dur}`, source_fields: ["fl.stops", "fl.dur"] },
      ],
      cons: [
        { text: `${p.ht.nights} nights at ${p.ht.name}`, source_fields: ["ht.nights", "ht.name"] },
      ],
    }));
    const json = JSON.stringify({ items });
    const final =
      behavior === "refusal"
        ? { stop_reason: "refusal", parsed_output: null, usage }
        : { stop_reason: "end_turn", parsed_output: { items }, usage };
    return {
      async *[Symbol.asyncIterator]() {
        if (behavior === "refusal") return;
        for (const text of json.match(/.{1,40}/gs) ?? []) {
          yield { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } };
        }
      },
      finalMessage: async () => final,
    };
  });
  const parse = vi.fn();
  return { messages: { parse, stream } as unknown as MessagesApi, stream, parse };
}
