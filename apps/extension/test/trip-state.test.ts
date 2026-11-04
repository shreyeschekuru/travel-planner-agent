import type { ConstraintDelta } from "@travellite/schema";
import { describe, expect, it } from "vitest";
import {
  affectedParts,
  applyToSummary,
  canRefine,
  initialTrip,
  reduceTrip,
} from "../src/worker/trip-state.js";
import { config, explanation, pkg } from "./fixtures.js";

const delta = (ops: ConstraintDelta["ops"], reason = "x"): ConstraintDelta => ({ ops, reason });

describe("reduceTrip", () => {
  it("follows a session from search to ready", () => {
    let s = initialTrip("s1", config);
    s = reduceTrip(s, { event: "results", data: { category: "flight", count: 10 } });
    s = reduceTrip(s, {
      event: "degraded",
      data: { category: "activity", error_kind: "UNAVAILABLE" },
    });
    expect(s.phase).toBe("searching");
    s = reduceTrip(s, { event: "packages", data: [pkg("a"), pkg("b")] });
    expect(s.phase).toBe("explaining");
    s = reduceTrip(s, { event: "explanation", data: explanation("a") });
    s = reduceTrip(s, { event: "awaiting_selection", data: {} });
    expect(s).toMatchObject({
      phase: "ready",
      results: { flight: { count: 10 }, activity: { degraded: "UNAVAILABLE" } },
    });
    expect(Object.keys(s.explanations)).toEqual(["a"]);
  });

  it("counts changed refinements and tracks the pending delta", () => {
    let s = reduceTrip(initialTrip("s1", config), { event: "awaiting_selection", data: {} });
    const d = delta([{ path: "hotel.min_rating", op: "set", value: 4 }], "Hotels rated 4+ only");
    s = reduceTrip(s, { event: "refine_applied", data: { delta: d, changed: true } });
    expect(s.phase).toBe("refining");
    expect(s.refinements).toEqual({
      count: 1,
      last: { reason: "Hotels rated 4+ only", changed: true },
      pending: d,
    });
    expect(canRefine(s)).toBe(false);
    s = reduceTrip(s, { event: "packages", data: [pkg("c")] });
    expect(s.explanations).toEqual({});
    s = reduceTrip(s, { event: "awaiting_selection", data: {} });
    expect(s.refinements.pending).toBeNull();
    expect(canRefine(s)).toBe(true);
  });

  it("keeps state for an unchanged refinement", () => {
    const ready = reduceTrip(initialTrip("s1", config), { event: "awaiting_selection", data: {} });
    const s = reduceTrip(ready, {
      event: "refine_applied",
      data: {
        delta: delta([{ path: "flight.max_stops", op: "set", value: 0 }], "Nonstop"),
        changed: false,
      },
    });
    expect(s.phase).toBe("ready");
    expect(s.refinements).toMatchObject({ count: 0, last: { changed: false } });
  });

  it("replaces packages with budget advice", () => {
    let s = reduceTrip(initialTrip("s1", config), { event: "packages", data: [pkg("a")] });
    s = reduceTrip(s, {
      event: "budget_advice",
      data: { cheapest_total_usd: 5200, driver: "hotel" },
    });
    expect(s).toMatchObject({ phase: "advice", packages: [], budget_advice: { driver: "hotel" } });
  });

  it("disallows refining after 10 refinements", () => {
    const s = {
      ...reduceTrip(initialTrip("s1", config), { event: "awaiting_selection", data: {} }),
    };
    s.refinements = { ...s.refinements, count: 10 };
    expect(canRefine(s)).toBe(false);
  });
});

describe("canRefine after an error", () => {
  const failed = (refinable: boolean) =>
    reduceTrip(initialTrip("s1", config), {
      event: "error",
      data: { code: "NOT_FOUND", message: "x", retryable: false, refinable },
    });

  it("allows refining only when a refinement can fix the cause", () => {
    expect(canRefine(failed(true))).toBe(true);
    expect(canRefine(failed(false))).toBe(false);
  });
});

describe("applyToSummary", () => {
  it("applies budget and date ops", () => {
    const cur = { budget_usd: 4000, departure_date: "2027-03-10", return_date: "2027-03-15" };
    expect(
      applyToSummary(
        cur,
        delta([
          { path: "budget.total_usd", op: "scale", value: 1.25 },
          { path: "dates.depart", op: "add", value: -1 },
          { path: "dates.return", op: "set", value: "2027-03-20" },
          { path: "hotel.min_rating", op: "set", value: 4 },
        ]),
      ),
    ).toEqual({ budget_usd: 5000, departure_date: "2027-03-09", return_date: "2027-03-20" });
  });
});

describe("affectedParts", () => {
  it("marks only the parts a delta changes", () => {
    expect(
      [...affectedParts(delta([{ path: "hotel.min_rating", op: "set", value: 4 }]))].sort(),
    ).toEqual(["hotel", "total"]);
    expect(
      [...affectedParts(delta([{ path: "dates.depart", op: "add", value: 1 }]))].sort(),
    ).toEqual(["activities", "flight", "hotel", "total"]);
    expect(affectedParts(null).size).toBe(0);
  });
});
