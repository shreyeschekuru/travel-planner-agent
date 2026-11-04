import { RefineChip, type ConstraintDelta, type Constraints } from "@travellite/schema";
import { describe, expect, it } from "vitest";
import { buildConstraints } from "../src/core/constraints.js";
import { applyDelta, chipDelta, invalidated } from "../src/core/deltas.js";

const NOW = new Date("2026-11-03T12:00:00Z");
const base: Constraints = buildConstraints({
  origin: "JFK",
  destination: "lisbon-pt",
  departure_date: "2027-03-10",
  return_date: "2027-03-15",
  date_flex_days: 0,
  budget_usd: 4000,
  travelers: 2,
  preferences: ["food"],
});

function apply(c: Constraints, delta: ConstraintDelta | null) {
  if (!delta) throw new Error("no delta");
  const r = applyDelta(c, delta, NOW);
  if (!r.ok) throw new Error(r.error);
  return r;
}

describe("chip deltas", () => {
  it("cheaper_hotel caps the price at 80% of the cheapest shown hotel", () => {
    const delta = chipDelta("cheaper_hotel", base, { hotelPerNight: 151 });
    expect(delta?.reason).toBe("Hotel max price set to $120/night");
    expect(apply(base, delta).constraints.hotel.max_price_per_night_usd).toBe(120);
  });

  it("cheaper_hotel lowers an existing cap by 20%", () => {
    const c = { ...base, hotel: { ...base.hotel, max_price_per_night_usd: 200 } };
    expect(apply(c, chipDelta("cheaper_hotel", c)).constraints.hotel.max_price_per_night_usd).toBe(
      160,
    );
  });

  it("cheaper_hotel aims for the next cheaper hotel when none is 20% cheaper", () => {
    const delta = chipDelta("cheaper_hotel", base, {
      hotelPerNight: 300,
      eligiblePerNight: [300, 280, 260.4, 310],
    });
    // Nothing is under $240, so the cap lands on the $280 hotel.
    expect(delta?.ops[0]).toEqual({ path: "hotel.max_price_per_night_usd", op: "set", value: 280 });
  });

  it("cheaper_hotel keeps the 20% cap when some hotel is under it", () => {
    const delta = chipDelta("cheaper_hotel", base, {
      hotelPerNight: 300,
      eligiblePerNight: [300, 180],
    });
    expect(delta?.ops[0]).toMatchObject({ value: 240 });
  });

  it("cheaper_hotel is unavailable when nothing cheaper exists", () => {
    const ctx = { hotelPerNight: 300, eligiblePerNight: [300, 320] };
    expect(chipDelta("cheaper_hotel", base, ctx)).toBeNull();
  });

  it("cheaper_hotel is unavailable with nothing to compare against", () => {
    expect(chipDelta("cheaper_hotel", base)).toBeNull();
  });

  it("better_hotel raises the minimum rating and lifts a price cap", () => {
    const c = { ...base, hotel: { min_rating: 3.5, max_price_per_night_usd: 120 } };
    const r = apply(c, chipDelta("better_hotel", c));
    expect(r.constraints.hotel).toEqual({ min_rating: 4 });
  });

  it("fewer_stops lowers max stops, and is a no-op at nonstop", () => {
    const r = apply(base, chipDelta("fewer_stops", base));
    expect(r.constraints.flight.max_stops).toBe(0);
    expect(r.changed).toBe(true);
    const again = apply(r.constraints, chipDelta("fewer_stops", r.constraints));
    expect(again.changed).toBe(false);
  });

  it("shifts both dates by a day", () => {
    expect(apply(base, chipDelta("shift_dates_earlier", base)).constraints.dates).toMatchObject({
      depart: "2027-03-09",
      return: "2027-03-14",
    });
    expect(apply(base, chipDelta("shift_dates_later", base)).constraints.dates).toMatchObject({
      depart: "2027-03-11",
      return: "2027-03-16",
    });
  });

  it("more_activities adds one a day, up to 6", () => {
    expect(apply(base, chipDelta("more_activities", base)).constraints.activities.max_per_day).toBe(
      3,
    );
    const full = { ...base, activities: { ...base.activities, max_per_day: 6 } };
    expect(apply(full, chipDelta("more_activities", full)).changed).toBe(false);
  });

  it.each(RefineChip.options)("%s has a user-facing reason", (chip) => {
    const d = chipDelta(chip, base, { hotelPerNight: 100 });
    expect(d?.reason.length).toBeGreaterThan(5);
  });
});

describe("applyDelta", () => {
  const op = (o: ConstraintDelta["ops"][number]): ConstraintDelta => ({ ops: [o], reason: "test" });
  const fails = (c: Constraints, d: ConstraintDelta) => {
    const r = applyDelta(c, d, NOW);
    return r.ok ? null : r.error;
  };

  it("is pure", () => {
    const before = structuredClone(base);
    apply(base, op({ path: "budget.total_usd", op: "set", value: 5000 }));
    expect(base).toEqual(before);
  });

  it("adds and removes interests", () => {
    const added = apply(
      base,
      op({ path: "activities.interests", op: "add", value: ["museums", "food"] }),
    );
    expect(added.constraints.activities.interests).toEqual(["food", "museums"]);
    const removed = apply(
      added.constraints,
      op({ path: "activities.interests", op: "remove", value: ["food"] }),
    );
    expect(removed.constraints.activities.interests).toEqual(["museums"]);
  });

  it("removes an optional limit", () => {
    const c = { ...base, flight: { max_stops: 1, max_price_usd: 900 } };
    expect(
      apply(c, op({ path: "flight.max_price_usd", op: "remove", value: 0 })).constraints.flight,
    ).toEqual({
      max_stops: 1,
    });
  });

  it("rounds money and ratings", () => {
    const c = { ...base, hotel: { min_rating: 3.5, max_price_per_night_usd: 133.33 } };
    const r = apply(c, op({ path: "hotel.max_price_per_night_usd", op: "scale", value: 0.7 }));
    expect(r.constraints.hotel.max_price_per_night_usd).toBe(93.33);
  });

  it("treats key order as no change", () => {
    const c = { ...base, hotel: { max_price_per_night_usd: 100, min_rating: 3.5 } };
    const r = apply(c, op({ path: "hotel.min_rating", op: "set", value: 3.5 }));
    expect(r.changed).toBe(false);
  });

  it.each<[string, ConstraintDelta]>([
    ["a past departure", op({ path: "dates.depart", op: "set", value: "2026-01-01" })],
    ["return before departure", op({ path: "dates.return", op: "set", value: "2027-03-09" })],
    ["a budget below the minimum", op({ path: "budget.total_usd", op: "set", value: 50 })],
    ["too many stops", op({ path: "flight.max_stops", op: "set", value: 4 })],
    ["a rating above 5", op({ path: "hotel.min_rating", op: "add", value: 2 })],
    [
      "scaling an unset value",
      op({ path: "hotel.max_price_per_night_usd", op: "scale", value: 0.8 }),
    ],
    ["a huge scale factor", op({ path: "budget.total_usd", op: "scale", value: 50 })],
    ["removing a required field", op({ path: "budget.total_usd", op: "remove", value: 0 })],
    ["an unknown interest", op({ path: "activities.interests", op: "add", value: ["skydiving"] })],
    ["a malformed time", op({ path: "flight.earliest_depart", op: "set", value: "9am" })],
    ["a fractional day shift", op({ path: "dates.depart", op: "add", value: 0.5 })],
    ["a text budget", op({ path: "budget.total_usd", op: "set", value: "lots" })],
  ])("rejects %s", (_label, delta) => {
    expect(fails(base, delta)).not.toBeNull();
  });
});

describe("invalidated", () => {
  it("maps delta paths to the categories to re-search", () => {
    const d = (path: ConstraintDelta["ops"][number]["path"]): ConstraintDelta => ({
      ops: [{ path, op: "set", value: 1 }],
      reason: "x",
    });
    expect([...invalidated(d("budget.total_usd"))]).toEqual([]);
    expect([...invalidated(d("hotel.min_rating"))]).toEqual(["hotel"]);
    expect([...invalidated(d("flight.max_stops"))]).toEqual(["flight"]);
    expect([...invalidated(d("activities.max_per_day"))]).toEqual(["activity"]);
    expect([...invalidated(d("dates.depart"))].sort()).toEqual(["activity", "flight", "hotel"]);
  });
});
