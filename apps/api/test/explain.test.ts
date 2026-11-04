import type { PackageExplanation, TripPackage } from "@travellite/schema";
import { PackageExplanation as Schema } from "@travellite/schema";
import { describe, expect, it } from "vitest";
import { buildConstraints } from "../src/core/constraints.js";
import { RedisSemaphore } from "../src/limits/semaphore.js";
import { SpendGuard } from "../src/limits/spend.js";
import { LlmClient } from "../src/llm/client.js";
import { compactPackage } from "../src/llm/explain-input.js";
import { EXPLAIN_SYSTEM, explainPackages } from "../src/llm/explain.js";
import { fallbackExplanation } from "../src/llm/fallback.js";
import { isGrounded, numbersIn, readPath } from "../src/llm/grounding.js";
import { fakeExplainLlm, type ExplainBehavior } from "./fake-llm.js";
import { useRedis } from "./helpers.js";

const redis = useRedis();

const constraints = buildConstraints({
  origin: "JFK",
  destination: "lisbon-pt",
  departure_date: "2027-03-10",
  return_date: "2027-03-15",
  date_flex_days: 0,
  budget_usd: 4000,
  travelers: 2,
  preferences: ["food"],
});

function pkg(id: string, label: TripPackage["label"], total: number): TripPackage {
  return {
    id,
    label,
    total_usd: total,
    score: 0.8,
    score_breakdown: {
      cost_fit: 0.9,
      flight_convenience: 0.7,
      hotel_location: 0.6,
      rating: 0.84,
      pref_match: 0.5,
    },
    flight: {
      id: "duffel:off_1",
      category: "flight",
      title: "TAP, nonstop",
      price: { amount: 1400, currency: "USD" },
      price_basis: "total",
      url: "https://www.google.com/travel/flights?q=x",
      attrs: {
        depart_at: "2027-03-10T18:00:00",
        arrive_at: "2027-03-11T06:30:00",
        return_depart_at: "2027-03-15T11:00:00",
        return_arrive_at: "2027-03-15T14:00:00",
        stops: 0,
        duration_min: 450,
        carrier: "TP",
      },
    },
    hotel: {
      id: "duffel:srr_1",
      category: "hotel",
      title: "Hotel Garden Lisbon",
      price: { amount: 1100, currency: "USD" },
      price_basis: "total",
      rating: 4.2,
      url: "https://www.google.com/travel/search?q=x",
      attrs: { checkin: "2027-03-10", checkout: "2027-03-15", nights: 5, km_from_center: 1.3 },
    },
    activities: [
      {
        id: "viator:1",
        category: "activity",
        title: "Lisbon Food Tour",
        price: { amount: 80, currency: "USD" },
        price_basis: "per_person",
        rating: 4.8,
        url: "https://www.viator.com/tours/x",
        attrs: { tags: ["food"], duration_min: 180 },
      },
    ],
  };
}
const packages = [pkg("pkg_a", "best_value", 2660), pkg("pkg_b", "upgrade", 3480)];

function llm(behavior: ExplainBehavior) {
  const fake = fakeExplainLlm(behavior);
  const client = new LlmClient({
    messages: fake.messages,
    spend: new SpendGuard(redis(), 10),
    semaphore: new RedisSemaphore(redis(), "llm-explain", 2),
  });
  return { client, stream: fake.stream };
}

async function run(behavior: ExplainBehavior) {
  const { client, stream } = llm(behavior);
  const emitted: PackageExplanation[] = [];
  const result = await explainPackages(client, packages, constraints, (e) => void emitted.push(e));
  return { result, emitted, stream };
}

describe("grounding", () => {
  const input = compactPackage(packages[0]!, constraints);

  it("reads dotted paths, including array indexes", () => {
    expect(readPath(input, "fl.stops")).toBe(0);
    expect(readPath(input, "acts.0.title")).toBe("Lisbon Food Tour");
    expect(readPath(input, "ht.nope")).toBeUndefined();
    expect(readPath(input, "__proto__")).toBeUndefined();
  });

  it("parses numbers with thousands separators", () => {
    expect(numbersIn("Total $2,660 for 5 nights, 7h30m")).toEqual([2660, 5, 7, 30]);
  });

  it("accepts claims whose numbers appear in the cited fields", () => {
    expect(isGrounded({ text: "Total $2,660", source_fields: ["total"] }, input)).toBe(true);
    expect(
      isGrounded({ text: "Nonstop, 7h30m", source_fields: ["fl.stops", "fl.dur"] }, input),
    ).toBe(true);
    expect(isGrounded({ text: "Total $2,661", source_fields: ["total"] }, input)).toBe(true); // rounding
  });

  it("drops invented numbers and missing fields", () => {
    expect(isGrounded({ text: "Total $2,500", source_fields: ["total"] }, input)).toBe(false);
    expect(isGrounded({ text: "Great pool", source_fields: ["ht.pool"] }, input)).toBe(false);
    expect(isGrounded({ text: "Saves $340", source_fields: ["total", "budget"] }, input)).toBe(
      false,
    );
  });

  it("passes every fallback claim", () => {
    for (const p of packages) {
      const c = compactPackage(p, constraints);
      const e = fallbackExplanation(c);
      expect(Schema.safeParse(e).success).toBe(true);
      for (const claim of [...e.pros, ...e.cons]) expect(isGrounded(claim, c)).toBe(true);
    }
  });
});

describe("explainPackages", () => {
  it("emits one grounded explanation per package", async () => {
    const { result, emitted, stream } = await run("grounded");
    expect(stream).toHaveBeenCalledTimes(1);
    expect(emitted.map((e) => e.package_id)).toEqual(["pkg_a", "pkg_b"]);
    expect(emitted[0]!.pros[0]!.text).toBe("Total $2,660 for the trip");
    expect(result).toMatchObject({ dropped_claims: 0 });
    expect(result.failure).toBeUndefined();
  });

  it("sends trimmed input in data blocks with the cached system prompt", async () => {
    const { stream } = await run("grounded");
    const params = stream.mock.calls[0]![0] as unknown as {
      system: { text: string }[];
      messages: { content: string }[];
    };
    expect(params.system[0]!.text.startsWith(EXPLAIN_SYSTEM)).toBe(true);
    const content = params.messages[0]!.content;
    expect(content).toContain('<data name="packages">');
    expect(content).not.toContain("google.com"); // URLs are not sent
    expect(content).not.toContain("duffel:"); // nor provider IDs
  });

  it("drops a hallucinated claim and tops up from the fallback", async () => {
    const { result, emitted } = await run("hallucinated");
    expect(result.dropped_claims).toBe(2);
    for (const e of emitted) {
      expect(e.pros.some((c) => c.text.includes("breakfast"))).toBe(false);
      expect(e.pros.length).toBeGreaterThanOrEqual(2);
      expect(Schema.safeParse(e).success).toBe(true);
    }
  });

  it.each(["refusal", "throws"] as const)("falls back to code bullets on %s", async (behavior) => {
    const { result, emitted } = await run(behavior);
    expect(result.failure).toBeDefined();
    expect(emitted).toHaveLength(2);
    expect(emitted[0]).toEqual(fallbackExplanation(compactPackage(packages[0]!, constraints)));
  });

  it("keeps the system prompt above the 512-token cache minimum", () => {
    // ~4 characters per token is a conservative floor for English prose.
    expect(EXPLAIN_SYSTEM.length / 4).toBeGreaterThan(512);
  });
});
