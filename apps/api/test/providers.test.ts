import { cityById, type City } from "@travellite/schema";
import { describe, expect, it } from "vitest";
import { findFixturesDir, fixtureTransport } from "../src/providers/fixtures.js";
import { parseEcbXml } from "../src/providers/fx.js";
import { isoDurationMinutes } from "../src/providers/normalize.js";
import { preferencesFor } from "../src/providers/viator.js";
import { standaloneProviders } from "../scripts/standalone.js";
import {
  DEGRADED_ACTIVITIES_CITY,
  NO_FLIGHTS,
  SPECIAL_ORIGINS,
  TEST_CITIES,
} from "../scripts/synthetic.js";

const dir = findFixturesDir();
const misses: string[] = [];

function providers() {
  const dropped: number[] = [];
  const sleeps: number[] = [];
  const p = standaloneProviders(
    fixtureTransport(dir, (m) => misses.push(m)),
    { duffel: "t", viator: "t" },
    {
      sleep: async (ms) => void sleeps.push(ms),
      onDropped: (n) => dropped.push(n),
    },
  );
  return { ...p, dropped, sleeps };
}

const city = (id: string): City => cityById(id)!;
// Different dates and trip length from the recording, to exercise date shifting.
const trip = { depart: "2027-03-10", return: "2027-03-15" };

describe("Duffel flights (fixtures)", () => {
  it("returns the 10 cheapest offers with shifted dates", async () => {
    const p = providers();
    const r = await p.flights.search({ origin: "JFK", destination: "PAR", ...trip, travelers: 2 });
    if (!r.ok) throw new Error(r.error.kind);
    expect(r.value).toHaveLength(10);
    const prices = r.value.map((o) => o.price.amount);
    expect(prices).toEqual([...prices].sort((a, b) => a - b));
    for (const o of r.value) {
      expect(o.id).toMatch(/^duffel:off_/);
      expect(o.price_basis).toBe("total");
      expect(o.url.startsWith("https://www.google.com/travel/flights?")).toBe(true);
      expect(o.attrs.depart_at.startsWith("2027-03-10")).toBe(true);
      expect(o.attrs.return_depart_at.startsWith("2027-03-15")).toBe(true);
      expect(o.attrs.duration_min).toBeGreaterThan(0);
    }
    expect(p.dropped).toEqual([1]); // the malformed offer
  });

  it("returns an empty list when no flights exist", async () => {
    const r = await providers().flights.search({ ...NO_FLIGHTS, ...trip, travelers: 2 });
    expect(r).toEqual({ ok: true, value: [] });
  });

  it("maps an invalid IATA code to NOT_FOUND", async () => {
    const r = await providers().flights.search({
      origin: SPECIAL_ORIGINS.invalid,
      destination: "PAR",
      ...trip,
      travelers: 2,
    });
    expect(r).toMatchObject({ ok: false, error: { kind: "NOT_FOUND" } });
  });

  it("retries a 429 once, then reports RATE_LIMIT", async () => {
    const p = providers();
    const r = await p.flights.search({
      origin: SPECIAL_ORIGINS.rateLimited,
      destination: "PAR",
      ...trip,
      travelers: 2,
    });
    expect(r).toMatchObject({ ok: false, error: { kind: "RATE_LIMIT", retry_after_ms: 1000 } });
    expect(p.sleeps).toEqual([1000]);
  });
});

describe("Duffel stays (fixtures)", () => {
  it("returns the 10 best-rated hotels for the requested dates", async () => {
    const r = await providers().hotels.search({
      city: city("paris-fr"),
      checkin: trip.depart,
      checkout: trip.return,
      travelers: 2,
    });
    if (!r.ok) throw new Error(r.error.kind);
    expect(r.value).toHaveLength(10);
    const ratings = r.value.map((o) => o.rating ?? 0);
    expect(ratings).toEqual([...ratings].sort((a, b) => b - a));
    for (const o of r.value) {
      expect(o.price_basis).toBe("total");
      expect(o.attrs).toMatchObject({ checkin: trip.depart, checkout: trip.return, nights: 5 });
      expect(o.attrs.km_from_center).toBeLessThanOrEqual(5);
      expect(o.rating).toBeLessThanOrEqual(5);
    }
  });

  it("converts non-USD prices with ECB rates", async () => {
    const transport = fixtureTransport(dir);
    const req = {
      city: city("london-gb"),
      checkin: trip.depart,
      checkout: trip.return,
      travelers: 2,
    };
    const r = await providers().hotels.search(req);
    if (!r.ok) throw new Error(r.error.kind);
    // Find the raw GBP price for the first hotel and convert it by hand: GBP -> EUR -> USD.
    const raw = await transport(
      {
        method: "POST",
        url: "https://api.duffel.com/stays/search",
        body: {
          data: {
            rooms: 1,
            guests: [{ type: "adult" }, { type: "adult" }],
            check_in_date: trip.depart,
            check_out_date: trip.return,
            location: {
              radius: 5,
              geographic_coordinates: {
                latitude: req.city.center.lat,
                longitude: req.city.center.lng,
              },
            },
          },
        },
      },
      AbortSignal.timeout(1000),
    );
    const results = (
      raw.body as {
        data: {
          results: {
            id: string;
            cheapest_rate_total_amount: string;
            cheapest_rate_currency: string;
          }[];
        };
      }
    ).data.results;
    const first = r.value[0]!;
    const source = results.find((x) => `duffel:${x.id}` === first.id)!;
    expect(source.cheapest_rate_currency).toBe("GBP");
    expect(first.price.amount).toBeCloseTo(
      (Number(source.cheapest_rate_total_amount) / 0.85) * 1.08,
      1,
    );
  });

  it("returns an empty list when nothing is available", async () => {
    const r = await providers().hotels.search({
      city: TEST_CITIES.empty,
      checkin: trip.depart,
      checkout: trip.return,
      travelers: 2,
    });
    expect(r).toEqual({ ok: true, value: [] });
  });

  it("maps a rejected location to NOT_FOUND", async () => {
    const r = await providers().hotels.search({
      city: TEST_CITIES.invalid,
      checkin: trip.depart,
      checkout: trip.return,
      travelers: 2,
    });
    expect(r).toMatchObject({ ok: false, error: { kind: "NOT_FOUND" } });
  });

  it("reports RATE_LIMIT on 429", async () => {
    const r = await providers().hotels.search({
      city: TEST_CITIES.rateLimited,
      checkin: trip.depart,
      checkout: trip.return,
      travelers: 2,
    });
    expect(r).toMatchObject({ ok: false, error: { kind: "RATE_LIMIT" } });
  });
});

describe("Viator activities (fixtures)", () => {
  it("returns the top 20 by rating, priced per person", async () => {
    const r = await providers().activities.search({ city: city("lisbon-pt") });
    if (!r.ok) throw new Error(r.error.kind);
    expect(r.value).toHaveLength(20);
    const ratings = r.value.map((o) => o.rating ?? 0);
    expect(ratings).toEqual([...ratings].sort((a, b) => b - a));
    for (const o of r.value) {
      expect(o.id).toMatch(/^viator:/);
      expect(o.price_basis).toBe("per_person");
      expect(new URL(o.url).hostname).toBe("www.viator.com");
      expect(o.attrs.duration_min).toBeGreaterThan(0);
    }
    expect(r.value.some((o) => o.attrs.tags.length > 0)).toBe(true);
  });

  it("returns an empty list for a city with no products", async () => {
    expect(await providers().activities.search({ city: TEST_CITIES.empty })).toEqual({
      ok: true,
      value: [],
    });
  });

  it("reports RATE_LIMIT on 429", async () => {
    const r = await providers().activities.search({ city: TEST_CITIES.rateLimited });
    expect(r).toMatchObject({ ok: false, error: { kind: "RATE_LIMIT" } });
  });

  it("reports UNAVAILABLE when the provider is down (degraded case)", async () => {
    const r = await providers().activities.search({ city: city(DEGRADED_ACTIVITIES_CITY) });
    expect(r).toMatchObject({ ok: false, error: { kind: "UNAVAILABLE" } });
  });
});

describe("fixture coverage", () => {
  it("never missed a fixture in the tests above", () => {
    // Error-case tests above expect specific kinds; a miss would show up as NOT_FOUND instead.
    expect(misses).toEqual([]);
  });
});

describe("normalization helpers", () => {
  it("parses ISO 8601 durations", () => {
    expect(isoDurationMinutes("PT02H26M")).toBe(146);
    expect(isoDurationMinutes("P1DT2H")).toBe(1560);
    expect(isoDurationMinutes("PT45M")).toBe(45);
    expect(isoDurationMinutes("PT")).toBeNull();
    expect(isoDurationMinutes("2 hours")).toBeNull();
  });

  it("maps Viator tag names to preferences", () => {
    expect(preferencesFor(["Food Tours", "Wine Tastings"])).toEqual(["food"]);
    expect(preferencesFor(["Museums & Exhibitions", "Family-friendly"])).toEqual([
      "museums",
      "family",
    ]);
    expect(preferencesFor(["Transfers"])).toEqual([]);
  });

  it("parses the ECB XML", () => {
    const rates = parseEcbXml(
      `<Cube currency='USD' rate='1.08'/><Cube currency="JPY" rate="161.2"/>`,
    );
    expect(rates).toEqual({ EUR: 1, USD: 1.08, JPY: 161.2 });
  });
});
