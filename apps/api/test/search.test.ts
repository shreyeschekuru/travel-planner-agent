import { describe, expect, it } from "vitest";
import { createProviders } from "../src/providers/index.js";
import { findFixturesDir, fixtureTransport } from "../src/providers/fixtures.js";
import type { HttpRequest, Transport } from "../src/providers/http.js";
import { datePairs } from "../src/search/date-pairs.js";
import { SearchService, type SearchRequest } from "../src/search/search.js";
import { Cache } from "../src/store/cache.js";
import { testConfig, useRedis } from "./helpers.js";

const NOW = new Date("2026-11-02T12:00:00Z");
const base: SearchRequest = {
  origin: "JFK",
  destination: "paris-fr",
  depart: "2027-03-10",
  return: "2027-03-15",
  flex_days: 0,
  travelers: 2,
};

const kind = (r: HttpRequest) => {
  const path = new URL(r.url).pathname;
  if (path.includes("offer_requests")) return "flights";
  if (path.includes("stays")) return "hotels";
  if (path.includes("products/search")) return "activities";
  return "lookup";
};

describe("SearchService", () => {
  const redis = useRedis();

  function service() {
    const calls: string[] = [];
    const inner = fixtureTransport(findFixturesDir());
    const transport: Transport = (req, signal) => {
      calls.push(kind(req));
      return inner(req, signal);
    };
    const cache = new Cache(redis());
    // The fake sleep never lets the shared bucket refill, so give it room for every call here.
    const config = testConfig({ DUFFEL_RATE_PER_SEC: "100", VIATOR_RATE_PER_SEC: "100" });
    const providers = createProviders(config, redis(), cache, { transport, sleep: async () => {} });
    const count = (k: string) => calls.filter((c) => c === k).length;
    return { search: new SearchService(cache, providers, () => NOW), calls, count };
  }

  it("returns all three categories for the requested dates", async () => {
    const { search } = service();
    const r = await search.search(base);
    expect(r.date_pairs).toEqual([{ depart: "2027-03-10", return: "2027-03-15", shift: 0 }]);
    expect(r.flights).toMatchObject({ ok: true, cached: false });
    expect(r.flights.ok && r.flights.options).toHaveLength(10);
    expect(r.hotels.ok && r.hotels.options).toHaveLength(10);
    expect(r.activities.ok && r.activities.options).toHaveLength(20);
  });

  it("serves a repeat search from the cache with zero provider calls", async () => {
    const { search, calls } = service();
    await search.search(base);
    calls.length = 0;
    const again = await search.search(base);
    expect(calls).toEqual([]);
    expect(again.flights).toMatchObject({ ok: true, cached: true });
    expect(again.hotels).toMatchObject({ ok: true, cached: true });
  });

  it("makes zero flight or hotel calls for a session after prefetch", async () => {
    const { search, calls, count } = service();
    await search.prefetch({ ...base, flex_days: 1 });
    expect(count("flights")).toBe(3);
    expect(count("hotels")).toBe(3);
    calls.length = 0;
    const r = await search.search({ ...base, flex_days: 1 });
    expect(count("flights")).toBe(0);
    expect(count("hotels")).toBe(0);
    expect(r.flights).toMatchObject({ ok: true, cached: true });
  });

  it("stores every option by ID for later link resolution", async () => {
    const { search } = service();
    const r = await search.search(base);
    const ids = r.flights.ok ? r.flights.options.map((o) => o.id) : [];
    const stored = await new Cache(redis()).getOptions(ids);
    expect(stored.size).toBe(ids.length);
  });

  it("searches each cache entry once when requests overlap", async () => {
    const { search, count } = service();
    await Promise.all([search.search(base), search.search(base), search.prefetch(base)]);
    expect(count("flights")).toBe(1);
    expect(count("hotels")).toBe(1);
    expect(count("activities")).toBe(1);
  });

  it("keeps at most 3 date pairs and 10 flights across a flex window", async () => {
    const { search, count } = service();
    const r = await search.search({ ...base, flex_days: 2 });
    expect(count("flights")).toBe(5);
    expect(r.date_pairs).toHaveLength(3);
    if (!r.flights.ok || !r.hotels.ok) throw new Error("expected results");
    expect(r.flights.options.length).toBeLessThanOrEqual(10);
    const kept = new Set(r.date_pairs.map((p) => p.depart));
    expect(r.hotels.options.every((h) => kept.has(h.attrs.checkin))).toBe(true);
    expect(r.hotels.options).toHaveLength(30);
    expect(new Set(r.hotels.options.map((h) => h.id)).size).toBe(30);
  });

  it("reports a degraded category without failing the others", async () => {
    const { search } = service();
    const r = await search.search({ ...base, destination: "cancun-mx" });
    expect(r.activities).toMatchObject({ ok: false, error: { kind: "UNAVAILABLE" } });
    expect(r.flights.ok).toBe(true);
    expect(r.hotels.ok).toBe(true);
  });

  it("does not cache errors", async () => {
    const { search, count } = service();
    await search.search({ ...base, destination: "cancun-mx" });
    await search.search({ ...base, destination: "cancun-mx" });
    expect(count("activities")).toBe(4); // two attempts per search
  });

  it("returns NOT_FOUND everywhere for an unknown city", async () => {
    const { search, calls } = service();
    const r = await search.search({ ...base, destination: "atlantis-zz" });
    expect(r.flights).toMatchObject({ ok: false, error: { kind: "NOT_FOUND" } });
    expect(calls).toEqual([]);
  });
});

describe("datePairs", () => {
  it("shifts the whole trip, requested dates first", () => {
    expect(datePairs("2027-03-10", "2027-03-15", 1, NOW)).toEqual([
      { depart: "2027-03-10", return: "2027-03-15", shift: 0 },
      { depart: "2027-03-09", return: "2027-03-14", shift: -1 },
      { depart: "2027-03-11", return: "2027-03-16", shift: 1 },
    ]);
  });

  it("drops pairs departing before today", () => {
    const pairs = datePairs("2026-11-03", "2026-11-06", 2, NOW);
    expect(pairs.map((p) => p.shift)).toEqual([0, -1, 1, 2]);
  });
});
