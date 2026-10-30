import { describe, expect, it } from "vitest";
import {
  ConstraintDelta,
  Option,
  PackageExplanation,
  RefineRequest,
  SessionEvent,
  parseVacationConfig,
  toRouteSchema,
  VacationConfigShape,
} from "../src/index.js";

const NOW = new Date("2026-10-30T12:00:00Z");
const config = {
  origin: "ATL",
  destination: "paris-fr",
  departure_date: "2026-12-01",
  return_date: "2026-12-07",
  date_flex_days: 2,
  budget_usd: 3000,
  travelers: 2,
  preferences: ["museums", "food"],
};

describe("VacationConfig", () => {
  it("accepts a valid config", () => {
    expect(parseVacationConfig(config, NOW).success).toBe(true);
  });

  it.each([
    ["return before departure", { return_date: "2026-11-30" }],
    ["same-day return", { return_date: "2026-12-01" }],
    ["departure in the past", { departure_date: "2026-10-01" }],
    ["departure > 365 days out", { departure_date: "2027-11-30", return_date: "2027-12-05" }],
    ["unreal date", { return_date: "2026-02-30" }],
    ["too many travelers", { travelers: 10 }],
    ["fractional travelers", { travelers: 1.5 }],
    ["budget too low", { budget_usd: 99 }],
    ["budget too high", { budget_usd: 100_001 }],
    ["unknown preference", { preferences: ["skiing"] }],
    ["duplicate preference", { preferences: ["food", "food"] }],
    ["bad flex", { date_flex_days: 3 }],
    ["lowercase IATA", { origin: "atl" }],
    ["bad city slug", { destination: "Paris, FR" }],
  ])("rejects %s", (_name, patch) => {
    expect(parseVacationConfig({ ...config, ...patch }, NOW).success).toBe(false);
  });

  it("rejects unknown fields in the route JSON schema", () => {
    expect(toRouteSchema(VacationConfigShape)).toMatchObject({
      $schema: "http://json-schema.org/draft-07/schema#",
      additionalProperties: false,
    });
  });
});

const flight = {
  id: "amadeus:abc123",
  category: "flight",
  title: "Delta DL86",
  price: { amount: 840, currency: "USD" },
  price_basis: "total",
  url: "https://www.delta.com/book?x=1",
  attrs: {
    depart_at: "2026-12-01T17:40:00-05:00",
    arrive_at: "2026-12-02T07:25:00+01:00",
    return_depart_at: "2026-12-07T10:15:00+01:00",
    stops: 0,
    duration_min: 525,
    carrier: "DL",
  },
};

describe("Option", () => {
  it("accepts a valid flight", () => {
    expect(Option.safeParse(flight).success).toBe(true);
  });

  it.each(["http://www.delta.com/", "javascript:alert(1)", "data:text/html,hi"])(
    "rejects non-https url %s",
    (url) => {
      expect(Option.safeParse({ ...flight, url }).success).toBe(false);
    },
  );

  it("rejects attrs that don't match the category", () => {
    expect(Option.safeParse({ ...flight, category: "hotel" }).success).toBe(false);
  });

  it("rejects ids without a provider prefix", () => {
    expect(Option.safeParse({ ...flight, id: "abc123" }).success).toBe(false);
  });
});

describe("ConstraintDelta", () => {
  it("accepts allowlisted paths", () => {
    const d = {
      ops: [{ path: "hotel.max_price_per_night_usd", op: "scale", value: 0.8 }],
      reason: "Cheaper hotel",
    };
    expect(ConstraintDelta.safeParse(d).success).toBe(true);
  });

  it("rejects paths outside the allowlist", () => {
    const d = { ops: [{ path: "__proto__.polluted", op: "set", value: 1 }], reason: "x" };
    expect(ConstraintDelta.safeParse(d).success).toBe(false);
  });
});

describe("RefineRequest", () => {
  it("accepts a chip or text, not both", () => {
    expect(RefineRequest.safeParse({ chip: "cheaper_hotel" }).success).toBe(true);
    expect(RefineRequest.safeParse({ text: "closer to the beach" }).success).toBe(true);
    expect(RefineRequest.safeParse({ chip: "cheaper_hotel", text: "x" }).success).toBe(false);
    expect(RefineRequest.safeParse({ text: "x".repeat(201) }).success).toBe(false);
  });
});

describe("PackageExplanation", () => {
  it("requires 2-3 pros with source fields", () => {
    const claim = { text: "Nonstop flight", source_fields: ["flight.attrs.stops"] };
    const ok = { package_id: "p1", headline: "Best value", pros: [claim, claim], cons: [claim] };
    expect(PackageExplanation.safeParse(ok).success).toBe(true);
    expect(PackageExplanation.safeParse({ ...ok, pros: [claim] }).success).toBe(false);
    expect(
      PackageExplanation.safeParse({ ...ok, pros: [{ text: "x", source_fields: [] }, claim] })
        .success,
    ).toBe(false);
  });
});

describe("SessionEvent", () => {
  it("validates by event name", () => {
    expect(
      SessionEvent.safeParse({ event: "results", data: { category: "hotel", count: 7 } }).success,
    ).toBe(true);
    expect(
      SessionEvent.safeParse({ event: "results", data: { category: "car", count: 7 } }).success,
    ).toBe(false);
    expect(SessionEvent.safeParse({ event: "nope", data: {} }).success).toBe(false);
  });
});
