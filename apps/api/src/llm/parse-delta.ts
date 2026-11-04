import { ConstraintDelta, DeltaOp, MAX_REFINE_TEXT, type Constraints } from "@travellite/schema";
import { z } from "zod";
import type { LlmClient, LlmFailureReason } from "./client.js";
import { wrapData } from "./untrusted.js";

/** Stable instructions, prompt-cached. Op semantics match core/deltas.ts applyDelta. */
export const PARSE_DELTA_SYSTEM = `You turn a traveler's short request into a change to their trip constraints, for a travel planning app.

The app has already planned trip packages under the constraints shown in <data name="constraints">. The traveler wrote the request in <data name="request">. Context such as today's date and the cheapest hotel price currently shown is in <data name="context">. Translate the request into operations on these paths only:

budget.total_usd: total trip budget in USD for all travelers.
dates.depart, dates.return: trip dates, YYYY-MM-DD.
flight.max_stops: 0 to 3. flight.max_price_usd: max flight price in USD for all travelers.
flight.earliest_depart: earliest outbound departure time, HH:MM. flight.latest_arrive: latest outbound arrival time, HH:MM.
hotel.min_rating: 0 to 5. hotel.max_price_per_night_usd: USD per night. hotel.max_km_from_center: km.
activities.interests: a list drawn from beach, museums, food, nightlife, outdoors, shopping, family, relaxed_pace.
activities.max_per_day: 0 to 6. activities.max_price_each_usd: USD per person.

Operations:
- set: replace the value. Numbers for numeric paths, YYYY-MM-DD for dates, HH:MM for times, a list for interests.
- scale: multiply a numeric value that is already set, e.g. 0.8 for "20% cheaper". Only for paths that currently have a value.
- add: add a number to a numeric value, or a number of days to a date (negative moves earlier), or items to interests.
- remove: clear an optional limit (flight.max_price_usd, flight.earliest_depart, flight.latest_arrive, hotel.max_price_per_night_usd, hotel.max_km_from_center, activities.max_price_each_usd), or remove items from interests. Use value 0 when removing a limit.

Output:
- understood: true only if the request asks for a change these paths can express. False for questions, requests about bookings, payments, specific named hotels or airlines, or anything else.
- ops: 1 to 5 operations when understood, otherwise an empty list.
- reason: one short sentence the traveler will see, describing the change in plain words with the new values, for example "Hotel max price set to $150/night" or "Trip moved two days later". At most 160 characters.

Rules:
- Make the smallest change that does what the traveler asked. Do not change anything they did not mention.
- When they move the trip, move both dates by the same number of days unless they ask to change the trip length.
- "Cheaper hotel" without a number: scale hotel.max_price_per_night_usd by 0.8 if it is set, otherwise set it to 80% of the cheapest hotel price per night in the context, rounded down.
- "Nicer" or "better" hotel: raise hotel.min_rating by 0.5, at most 5.
- "Direct" or "nonstop" flights: set flight.max_stops to 0.
- More or fewer activities: change activities.max_per_day by 1 unless a number is given.
- Never output paths that are not listed above.`;

const ParsedDelta = z.object({
  understood: z.boolean(),
  ops: z.array(DeltaOp).max(5),
  reason: z.string().max(160),
});

export type ParseDeltaResult =
  | { ok: true; delta: ConstraintDelta }
  | { ok: false; reason: LlmFailureReason | "not_understood" | "too_long" };

export interface ParseDeltaContext {
  today: string;
  /** Cheapest per-night price among the hotels currently shown, if any. */
  hotel_per_night?: number;
}

/** One LLM call: free text (≤ 200 chars, wrapped as data) to a delta on allowlisted paths. */
export async function parseDelta(
  llm: LlmClient,
  text: string,
  constraints: Constraints,
  context: ParseDeltaContext,
): Promise<ParseDeltaResult> {
  if (text.length > MAX_REFINE_TEXT) return { ok: false, reason: "too_long" };
  const res = await llm
    .structured({
      name: "parse_delta",
      system: PARSE_DELTA_SYSTEM,
      input: [
        wrapData("constraints", constraints),
        wrapData("context", context),
        wrapData("request", text),
      ].join("\n"),
      schema: ParsedDelta,
      maxTokens: 400,
    })
    .catch(() => ({ ok: false as const, reason: "api_error" as const }));
  if (!res.ok) return { ok: false, reason: res.reason };
  if (!res.value.understood || res.value.ops.length === 0)
    return { ok: false, reason: "not_understood" };
  const delta = ConstraintDelta.safeParse({
    ops: res.value.ops,
    reason: res.value.reason || "Updated your trip",
  });
  return delta.success ? { ok: true, delta: delta.data } : { ok: false, reason: "not_understood" };
}
