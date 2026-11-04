import { PackageExplanation, type Constraints, type TripPackage } from "@travellite/schema";
import type { LlmClient, LlmFailureReason } from "./client.js";
import { compactPackage, type CompactPackage } from "./explain-input.js";
import { fallbackExplanation, topUp } from "./fallback.js";
import { isGrounded } from "./grounding.js";
import { wrapData } from "./untrusted.js";

/**
 * Stable instructions, byte-identical on every call so they are prompt-cached. Long enough
 * to clear the model's minimum cacheable prefix.
 */
export const EXPLAIN_SYSTEM = `You write short, factual explanations of trip packages for a travel planning app.

The app has already chosen 2 or 3 packages with code. Each package combines one round-trip flight, one hotel and zero or more activities, with a total price for all travelers. You do not choose, rank, price or change packages. Your only job is to explain each package so the traveler can compare them at a glance.

Input:
- A <data name="trip"> block with the traveler's budget, number of travelers, trip length and interests.
- A <data name="packages"> block: a JSON array of packages. Fields:
  id: package ID. label: best_value, best_location or upgrade.
  total: total price in USD for all travelers. budget: the traveler's total budget in USD. budget_pct: total as a percentage of budget.
  fl: flight. carrier, stops, dur (one-way duration), dep and arr (local times), price (USD, all travelers).
  ht: hotel. name, rating (0-5), km (distance from the city center), nights, price (USD, whole stay), per_night.
  acts: activities, each with title, tags and price_pp (USD per person). n_acts: how many. n_match: how many match the traveler's interests.
  sc: score components from 0 to 100 (cost_fit, flight_convenience, hotel_location, rating, pref_match). Higher is better.

Output, for every package in the input, exactly one item with:
- package_id: copied exactly from the input id.
- headline: at most 80 characters. Say what makes this package different from the others, in plain words.
- pros: 2 or 3 claims about real strengths of this package.
- cons: 1 to 3 claims about real trade-offs of this package.

Each claim has text (one short sentence, at most 120 characters) and source_fields: the input fields the claim is based on, written as dotted paths relative to the package, for example "total", "fl.stops", "ht.km", "acts.0.title", "sc.hotel_location".

Rules:
- Every number in a claim must appear in one of its source_fields. Copy numbers exactly; do not compute new numbers such as differences, averages or per-person prices.
- Only state what the fields show. Do not invent amenities, neighborhoods, views, airline service, weather, reviews or anything else not in the input.
- Compare packages only through their own fields, for example a lower total or fewer stops.
- Use US dollars written like $1,234. Write durations as they appear, for example 9h40m.
- Keep a neutral, helpful tone. No marketing language, exclamation marks or emoji.
- If the input looks wrong or incomplete, still describe only what is there.
- Return the items in the same order as the input packages.`;

export interface ExplainResult {
  explanations: PackageExplanation[];
  /** Why the model's output wasn't used, if it wasn't. */
  failure?: LlmFailureReason;
  /** Claims removed by the grounding check. */
  dropped_claims: number;
}

/**
 * One streamed LLM call for all packages (design.md §5.6). Each explanation is grounded and
 * emitted as soon as it completes; packages the model misses get code-generated bullets.
 */
export async function explainPackages(
  llm: LlmClient,
  packages: TripPackage[],
  constraints: Constraints,
  onExplanation: (e: PackageExplanation) => Promise<void> | void,
): Promise<ExplainResult> {
  const compact = new Map<string, CompactPackage>(
    packages.map((p) => [p.id, compactPackage(p, constraints)]),
  );
  const done = new Map<string, PackageExplanation>();
  let dropped = 0;

  const emit = async (e: PackageExplanation) => {
    done.set(e.package_id, e);
    await onExplanation(e);
  };

  const trip = {
    budget: constraints.budget.total_usd,
    travelers: constraints.travelers,
    nights: packages[0]?.hotel.attrs.nights,
    interests: constraints.activities.interests,
  };
  const call = llm.streamItems({
    name: "explain",
    system: EXPLAIN_SYSTEM,
    input: `${wrapData("trip", trip)}\n${wrapData("packages", [...compact.values()])}`,
    itemSchema: PackageExplanation,
    maxTokens: 400 * packages.length,
    onItem: async (item) => {
      // package_id is checked here rather than with an enum in the schema, so the request's
      // output format stays identical across sessions.
      const input = compact.get(item.package_id);
      if (!input || done.has(item.package_id)) return;
      const pros = item.pros.filter((c) => isGrounded(c, input));
      const cons = item.cons.filter((c) => isGrounded(c, input));
      dropped += item.pros.length - pros.length + item.cons.length - cons.length;
      await emit({ ...item, ...topUp(input, pros, cons) });
    },
  });
  // Explanations are optional; any failure falls back to code-generated bullets.
  const result = await call.catch(() => ({ ok: false as const, reason: "api_error" as const }));

  for (const [id, input] of compact) {
    if (!done.has(id)) await emit(fallbackExplanation(input));
  }
  return {
    explanations: packages.map((p) => done.get(p.id)!),
    ...(result.ok ? {} : { failure: result.reason }),
    dropped_claims: dropped,
  };
}
