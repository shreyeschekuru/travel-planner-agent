import {
  cityById,
  type ActivityOption,
  type Constraints,
  type FlightOption,
  type HotelOption,
  type VacationConfig,
} from "@travellite/schema";
import { describe, expect, it } from "vitest";
import { budgetAdvice } from "../src/core/budget-advice.js";
import { buildConstraints } from "../src/core/constraints.js";
import {
  costFit,
  flightTotal,
  hotelTotal,
  optimize,
  type OptimizerInput,
} from "../src/core/optimizer.js";
import { findFixturesDir, fixtureTransport } from "../src/providers/fixtures.js";
import { standaloneProviders } from "../scripts/standalone.js";

const config: VacationConfig = {
  origin: "JFK",
  destination: "lisbon-pt",
  departure_date: "2027-03-10",
  return_date: "2027-03-15",
  date_flex_days: 0,
  budget_usd: 4000,
  travelers: 2,
  preferences: ["food", "museums"],
};

describe("buildConstraints", () => {
  it("applies the design defaults", () => {
    expect(buildConstraints(config)).toEqual({
      dates: { depart: "2027-03-10", return: "2027-03-15", flex_days: 0 },
      budget: { total_usd: 4000, tolerance_pct: 5 },
      flight: { max_stops: 1 },
      hotel: { min_rating: 3.5 },
      activities: { interests: ["food", "museums"], max_per_day: 2 },
      travelers: 2,
    });
  });

  it("limits activities to one a day for relaxed_pace", () => {
    const c = buildConstraints({ ...config, preferences: ["beach", "relaxed_pace"] });
    expect(c.activities).toEqual({ interests: ["beach", "relaxed_pace"], max_per_day: 1 });
  });
});

// ---------- hand-built options ----------

const url = "https://www.google.com/travel/flights?q=x";
function flight(
  id: string,
  price: number,
  o: Partial<FlightOption["attrs"]> & { basis?: FlightOption["price_basis"] } = {},
): FlightOption {
  const { basis = "total", ...attrs } = o;
  return {
    id: `duffel:${id}`,
    category: "flight",
    title: id,
    price: { amount: price, currency: "USD" },
    price_basis: basis,
    url,
    attrs: {
      depart_at: "2027-03-10T09:00:00",
      arrive_at: "2027-03-10T21:00:00",
      return_depart_at: "2027-03-15T10:00:00",
      return_arrive_at: "2027-03-15T14:00:00",
      stops: 0,
      duration_min: 420,
      carrier: "TP",
      ...attrs,
    },
  };
}
function hotel(
  id: string,
  price: number,
  o: {
    rating?: number;
    km?: number;
    basis?: HotelOption["price_basis"];
    checkin?: string;
    checkout?: string;
  } = {},
): HotelOption {
  const checkin = o.checkin ?? "2027-03-10";
  const checkout = o.checkout ?? "2027-03-15";
  const nights = Math.round((Date.parse(checkout) - Date.parse(checkin)) / 86_400_000);
  return {
    id: `duffel:${id}`,
    category: "hotel",
    title: `Hotel ${id}`,
    price: { amount: price, currency: "USD" },
    price_basis: o.basis ?? "total",
    rating: o.rating ?? 4.2,
    url: "https://www.google.com/travel/search?q=x",
    attrs: { checkin, checkout, nights, km_from_center: o.km ?? 1 },
  };
}
function activity(
  id: string,
  price: number,
  tags: ActivityOption["attrs"]["tags"] = ["food"],
): ActivityOption {
  return {
    id: `viator:${id}`,
    category: "activity",
    title: `Tour ${id}`,
    price: { amount: price, currency: "USD" },
    price_basis: "per_person",
    rating: 4.6,
    url: "https://www.viator.com/tours/x",
    attrs: { tags, duration_min: 120 },
  };
}

const lisbon = cityById("lisbon-pt")!.center;
const constraints = buildConstraints(config);
const input = (o: Partial<OptimizerInput> = {}): OptimizerInput => ({
  flights: [
    flight("f1", 1200),
    flight("f2", 900, { stops: 1, duration_min: 600 }),
    flight("f3", 1500),
  ],
  hotels: [
    hotel("h1", 1000, { rating: 4.6, km: 0.5 }),
    hotel("h2", 700, { rating: 3.9, km: 3 }),
    hotel("h3", 1400, { rating: 4.8, km: 2 }),
  ],
  activities: [
    activity("a1", 40),
    activity("a2", 60, ["museums"]),
    activity("a3", 30, ["nightlife"]),
    activity("a4", 200),
  ],
  cityCenter: lisbon,
  ...o,
});

function packagesOf(r: ReturnType<typeof optimize>) {
  if (r.kind !== "packages") throw new Error(`expected packages, got ${r.kind}`);
  return r.packages;
}

describe("totals", () => {
  it("multiply by travelers and nights according to price_basis", () => {
    expect(flightTotal(flight("x", 500, { basis: "per_person" }), 3)).toBe(1500);
    expect(flightTotal(flight("x", 500), 3)).toBe(500);
    expect(hotelTotal(hotel("x", 100, { basis: "per_night" }))).toBe(500);
    expect(hotelTotal(hotel("x", 100))).toBe(100);
  });

  it("match each package's parts exactly", () => {
    for (const p of packagesOf(optimize(input(), constraints))) {
      const expected =
        flightTotal(p.flight, 2) +
        hotelTotal(p.hotel) +
        p.activities.reduce((s, a) => s + a.price.amount * 2, 0);
      expect(p.total_usd).toBeCloseTo(expected, 2);
    }
  });
});

describe("optimize", () => {
  it("returns 2–3 packages with distinct labels and distinct flight + hotel pairs", () => {
    const pkgs = packagesOf(optimize(input(), constraints));
    expect(pkgs.length).toBeGreaterThanOrEqual(2);
    expect(pkgs.length).toBeLessThanOrEqual(3);
    expect(new Set(pkgs.map((p) => p.label)).size).toBe(pkgs.length);
    expect(new Set(pkgs.map((p) => `${p.flight.id}|${p.hotel.id}`)).size).toBe(pkgs.length);
    expect(new Set(pkgs.map((p) => p.id)).size).toBe(pkgs.length);
  });

  it("uses a different hotel for each package when competitive ones exist", () => {
    const hotels = [
      hotel("h1", 1000, { rating: 4.6, km: 0.5 }),
      hotel("h2", 900, { rating: 4.5, km: 0.4 }),
      hotel("h3", 1200, { rating: 4.7, km: 0.8 }),
    ];
    const pkgs = packagesOf(optimize(input({ hotels }), constraints));
    expect(pkgs).toHaveLength(3);
    expect(new Set(pkgs.map((p) => p.hotel.title)).size).toBe(3);
  });

  it("gives best_location the best-located hotel among top-scoring packages", () => {
    const pkgs = packagesOf(optimize(input(), constraints));
    const location = pkgs.find((p) => p.label === "best_location")!;
    const others = pkgs.filter((p) => p !== location);
    for (const p of others) {
      expect(location.score_breakdown.hotel_location).toBeGreaterThanOrEqual(
        p.score_breakdown.hotel_location,
      );
    }
    expect(location.hotel.title).toBe("Hotel h1"); // 0.5 km out
  });

  it("still returns packages when only one hotel exists", () => {
    const pkgs = packagesOf(optimize(input({ hotels: [hotel("h1", 1000)] }), constraints));
    expect(pkgs.length).toBeGreaterThanOrEqual(2);
    expect(new Set(pkgs.map((p) => p.flight.id)).size).toBe(pkgs.length);
  });

  it("never exceeds the budget plus tolerance", () => {
    const tight = { ...constraints, budget: { total_usd: 2200, tolerance_pct: 5 } };
    for (const p of packagesOf(optimize(input(), tight)))
      expect(p.total_usd).toBeLessThanOrEqual(2310);
  });

  it("keeps activities under the budget, not the tolerance", () => {
    for (const p of packagesOf(optimize(input(), constraints))) {
      const base = flightTotal(p.flight, 2) + hotelTotal(p.hotel);
      if (p.activities.length) expect(p.total_usd).toBeLessThanOrEqual(Math.max(base, 4000));
    }
  });

  it("pairs flights only with hotels on the same dates", () => {
    const pkgs = packagesOf(
      optimize(
        input({
          flights: [
            flight("f1", 1000),
            flight("f9", 600, {
              depart_at: "2027-03-11T09:00:00",
              arrive_at: "2027-03-11T21:00:00",
              return_depart_at: "2027-03-16T10:00:00",
            }),
          ],
          hotels: [
            hotel("h1", 1000),
            hotel("h9", 900, { checkin: "2027-03-11", checkout: "2027-03-16" }),
          ],
        }),
        constraints,
      ),
    );
    for (const p of pkgs) {
      expect(p.hotel.attrs.checkin).toBe(p.flight.attrs.depart_at.slice(0, 10));
      expect(p.hotel.attrs.checkout).toBe(p.flight.attrs.return_depart_at.slice(0, 10));
    }
  });

  it("enforces stops and rating", () => {
    const r = optimize(
      input({ flights: [flight("f1", 900, { stops: 2 })], hotels: [hotel("h1", 500)] }),
      constraints,
    );
    expect(r).toEqual({ kind: "no_options", category: "flight" });
    const r2 = optimize(input({ hotels: [hotel("h1", 500, { rating: 3.0 })] }), constraints);
    expect(r2).toEqual({ kind: "no_options", category: "hotel" });
  });

  it("caps activities at max_per_day × nights and prefers matching ones", () => {
    const many = Array.from({ length: 20 }, (_, i) =>
      activity(`m${i}`, 10, i % 2 ? ["food"] : ["shopping"]),
    );
    const relaxed = { ...constraints, activities: { ...constraints.activities, max_per_day: 1 } };
    for (const p of packagesOf(optimize(input({ activities: many }), relaxed))) {
      expect(p.activities.length).toBeLessThanOrEqual(5);
      expect(p.activities.every((a) => a.attrs.tags.includes("food"))).toBe(true);
    }
  });

  it("builds packages without activities when that category is degraded", () => {
    const pkgs = packagesOf(optimize(input({ activities: [] }), constraints));
    expect(pkgs.every((p) => p.activities.length === 0)).toBe(true);
  });

  it("reports over_budget when no flight + hotel fits", () => {
    const low = { ...constraints, budget: { total_usd: 1000, tolerance_pct: 5 } };
    expect(optimize(input(), low)).toEqual({ kind: "over_budget" });
  });

  it("is deterministic", () => {
    expect(optimize(input(), constraints)).toEqual(optimize(input(), constraints));
  });

  it("runs 10 × 10 × 20 in under 50 ms", () => {
    const big = input({
      flights: Array.from({ length: 10 }, (_, i) =>
        flight(`bf${i}`, 700 + i * 37, { stops: i % 2, duration_min: 400 + i * 20 }),
      ),
      hotels: Array.from({ length: 10 }, (_, i) =>
        hotel(`bh${i}`, 600 + i * 55, { rating: 3.6 + i * 0.1, km: i * 0.4 }),
      ),
      activities: Array.from({ length: 20 }, (_, i) =>
        activity(`ba${i}`, 20 + i * 7, i % 3 ? ["food"] : ["beach"]),
      ),
    });
    optimize(big, constraints); // warm up
    const start = performance.now();
    for (let i = 0; i < 10; i++) optimize(big, constraints);
    expect((performance.now() - start) / 10).toBeLessThan(50);
  });
});

describe("costFit", () => {
  it("peaks at 85–100% of budget", () => {
    expect(costFit(900, 1000, 5)).toBe(1);
    expect(costFit(500, 1000, 5)).toBeLessThan(1);
    expect(costFit(1040, 1000, 5)).toBeLessThan(1);
    expect(costFit(500, 1000, 5)).toBeGreaterThan(costFit(100, 1000, 5));
  });
});

describe("budgetAdvice", () => {
  const low: Constraints = { ...constraints, budget: { total_usd: 1500, tolerance_pct: 5 } };

  it("reports the cheapest total and the category driving it", () => {
    const advice = budgetAdvice(input(), low, []);
    // f2 ($900, 1 stop) + h2 ($700); the flight is the larger part.
    expect(advice).toEqual({ cheapest_total_usd: 1600, driver: "flight" });
  });

  it("suggests the nearest cached date pair that fits", () => {
    const grid = [
      {
        depart: "2027-03-13",
        return: "2027-03-18",
        shift: 3,
        flights: [
          flight("g3", 500, {
            depart_at: "2027-03-13T09:00:00",
            return_depart_at: "2027-03-18T10:00:00",
          }),
        ],
        hotels: [hotel("g3h", 600, { checkin: "2027-03-13", checkout: "2027-03-18" })],
      },
      {
        depart: "2027-03-09",
        return: "2027-03-14",
        shift: -1,
        flights: [
          flight("g1", 700, {
            depart_at: "2027-03-09T09:00:00",
            return_depart_at: "2027-03-14T10:00:00",
          }),
        ],
        hotels: [hotel("g1h", 700, { checkin: "2027-03-09", checkout: "2027-03-14" })],
      },
    ];
    expect(budgetAdvice(input(), low, grid).nearest_fitting_dates).toEqual({
      depart: "2027-03-09",
      return: "2027-03-14",
      total_usd: 1400,
    });
  });
});

describe("optimize on fixtures", () => {
  const p = standaloneProviders(fixtureTransport(findFixturesDir()), { duffel: "t", viator: "t" });
  const trip = { depart: "2027-03-10", return: "2027-03-15" };

  async function fixtureInput(cityId: string, iata: string): Promise<OptimizerInput> {
    const city = cityById(cityId)!;
    const [f, h, a] = await Promise.all([
      p.flights.search({ origin: "JFK", destination: iata, ...trip, travelers: 2 }),
      p.hotels.search({ city, checkin: trip.depart, checkout: trip.return, travelers: 2 }),
      p.activities.search({ city }),
    ]);
    if (!f.ok || !h.ok || !a.ok) throw new Error("fixture search failed");
    return { flights: f.value, hotels: h.value, activities: a.value, cityCenter: city.center };
  }

  it("builds valid packages for Lisbon", async () => {
    const pkgs = packagesOf(optimize(await fixtureInput("lisbon-pt", "LIS"), constraints));
    expect(pkgs.length).toBeGreaterThanOrEqual(2);
    for (const pkg of pkgs) {
      expect(pkg.total_usd).toBeLessThanOrEqual(4200);
      expect(pkg.hotel.attrs.checkin).toBe("2027-03-10");
      expect(pkg.flight.attrs.stops).toBeLessThanOrEqual(1);
    }
  });

  it("returns budget advice for Reykjavik on a small budget", async () => {
    const c = { ...constraints, budget: { total_usd: 1500, tolerance_pct: 5 } };
    const inp = await fixtureInput("reykjavik-is", "REK");
    expect(optimize(inp, c)).toEqual({ kind: "over_budget" });
    const advice = budgetAdvice(inp, c, []);
    expect(advice.cheapest_total_usd).toBeGreaterThan(1575);
  });
});
