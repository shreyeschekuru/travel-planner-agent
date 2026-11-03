import {
  cityById,
  Option,
  type City,
  type OptionCategory,
  type ActivityOption,
  type FlightOption,
  type HotelOption,
} from "@travellite/schema";
import { traceable } from "langsmith/traceable";
import { z } from "zod";
import type { Cache } from "../store/cache.js";
import type { ActivitySearchParams } from "../providers/viator.js";
import type { FlightSearchParams } from "../providers/duffel-flights.js";
import type { HotelSearchParams } from "../providers/duffel-stays.js";
import type { ProviderError, Result, SearchProvider } from "../providers/provider.js";
import { datePairs, type DatePair } from "./date-pairs.js";

/** TTLs per design.md §5.3. Options outlive every list that references them. */
export const TTL_SECONDS = { flight: 15 * 60, hotel: 3600, activity: 86_400, option: 86_400 };
/** Date pairs kept after comparing flight prices across the flex window. */
export const KEPT_DATE_PAIRS = 3;
export const MAX_FLIGHTS = 10;

export interface SearchRequest {
  origin: string;
  destination: string;
  depart: string;
  return: string;
  flex_days: number;
  travelers: number;
}

export type CategoryResult<O extends Option = Option> =
  { ok: true; options: O[]; cached: boolean } | { ok: false; error: ProviderError };

export interface SearchResults {
  flights: CategoryResult<FlightOption>;
  /** Hotels for the kept date pairs only. */
  hotels: CategoryResult<HotelOption>;
  activities: CategoryResult<ActivityOption>;
  /** Date pairs the flights and hotels cover, best first. */
  date_pairs: DatePair[];
}

export interface SearchProviders {
  flights: SearchProvider<FlightSearchParams>;
  hotels: SearchProvider<HotelSearchParams>;
  activities: SearchProvider<ActivitySearchParams>;
}

export const cacheNames = {
  flights: (r: SearchRequest, pair: DatePair, iata: string) =>
    `flights:${r.origin}:${iata}:${pair.depart}:${pair.return}:${r.travelers}`,
  hotels: (city: City, pair: DatePair, travelers: number) =>
    `hotels:${city.id}:${pair.depart}:${pair.return}:${travelers}`,
  activities: (city: City) => `activities:${city.id}`,
};

const CachedOptions = z.array(Option);
type Unit<O extends Option> =
  { ok: true; options: O[]; cached: boolean } | { ok: false; error: ProviderError };

const notFound = { ok: false, error: { kind: "NOT_FOUND" } } as const;

function merge<O extends Option>(units: Unit<O>[]): CategoryResult<O> {
  const good = units.filter((u) => u.ok);
  if (good.length === 0) return units.find((u) => !u.ok) ?? notFound;
  return { ok: true, options: good.flatMap((u) => u.options), cached: good.every((u) => u.cached) };
}

const cheapest = (u: Unit<FlightOption>) =>
  u.ok && u.options.length ? Math.min(...u.options.map((o) => o.price.amount)) : Infinity;

/**
 * Cache-first search across all three categories. Each cache entry is one provider call,
 * fetched at most once at a time per instance; misses are fetched in parallel.
 */
export class SearchService {
  private readonly inflight = new Map<string, Promise<Unit<Option>>>();

  constructor(
    private readonly cache: Cache,
    private readonly providers: SearchProviders,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async search(req: SearchRequest, signal?: AbortSignal): Promise<SearchResults> {
    const city = cityById(req.destination);
    const pairs = datePairs(req.depart, req.return, req.flex_days, this.now());
    if (!city || pairs.length === 0) {
      return { flights: notFound, hotels: notFound, activities: notFound, date_pairs: [] };
    }
    // Hotels for every candidate pair run alongside flights, trading a few extra
    // hotel calls (cached) for not waiting on flights first.
    const [flightUnits, hotelUnits, activities] = await Promise.all([
      Promise.all(pairs.map((p) => this.flightUnit(req, city, p, signal))),
      Promise.all(pairs.map((p) => this.hotelUnit(req, city, p, signal))),
      this.activities(city, signal),
    ]);

    const ranked = pairs
      .map((pair, i) => ({ pair, flights: flightUnits[i]!, hotels: hotelUnits[i]! }))
      .sort((a, b) => cheapest(a.flights) - cheapest(b.flights));
    const flightsOk = ranked.some((r) => r.flights.ok && r.flights.options.length > 0);
    // Without flights to rank by, keep the requested dates.
    const kept = flightsOk
      ? ranked.slice(0, KEPT_DATE_PAIRS)
      : ranked.filter((r) => r.pair.shift === 0);

    const flights = merge(kept.map((k) => k.flights));
    return {
      flights: flights.ok
        ? {
            ...flights,
            options: flights.options
              .sort((a, b) => a.price.amount - b.price.amount)
              .slice(0, MAX_FLIGHTS),
          }
        : flights,
      hotels: merge(kept.map((k) => k.hotels)),
      activities,
      date_pairs: kept.map((k) => k.pair),
    };
  }

  /** Warms the flight and hotel caches for every candidate date pair. Never throws. */
  async prefetch(req: SearchRequest): Promise<void> {
    const city = cityById(req.destination);
    if (!city) return;
    const pairs = datePairs(req.depart, req.return, req.flex_days, this.now());
    await Promise.allSettled(
      pairs.flatMap((p) => [this.flightUnit(req, city, p), this.hotelUnit(req, city, p)]),
    );
  }

  /** Resolves when every fetch in flight on this instance has finished. For tests and shutdown. */
  async idle(): Promise<void> {
    while (this.inflight.size) await Promise.allSettled([...this.inflight.values()]);
  }

  private flightUnit(req: SearchRequest, city: City, pair: DatePair, signal?: AbortSignal) {
    const params = {
      origin: req.origin,
      destination: city.iata,
      depart: pair.depart,
      return: pair.return,
      travelers: req.travelers,
    };
    return this.unit("flight", cacheNames.flights(req, pair, city.iata), TTL_SECONDS.flight, () =>
      this.providers.flights.search(params, signal),
    ) as Promise<Unit<FlightOption>>;
  }

  private hotelUnit(req: SearchRequest, city: City, pair: DatePair, signal?: AbortSignal) {
    const params = { city, checkin: pair.depart, checkout: pair.return, travelers: req.travelers };
    return this.unit("hotel", cacheNames.hotels(city, pair, req.travelers), TTL_SECONDS.hotel, () =>
      this.providers.hotels.search(params, signal),
    ) as Promise<Unit<HotelOption>>;
  }

  private activities(city: City, signal?: AbortSignal) {
    return this.unit("activity", cacheNames.activities(city), TTL_SECONDS.activity, () =>
      this.providers.activities.search({ city }, signal),
    ) as Promise<Unit<ActivityOption>>;
  }

  private unit(
    category: OptionCategory,
    name: string,
    ttl: number,
    fetch: () => Promise<Result<Option[]>>,
  ): Promise<Unit<Option>> {
    const existing = this.inflight.get(name);
    if (existing) return existing;
    const run = traceable(
      async (cacheKey: string): Promise<Unit<Option>> => {
        const hit = CachedOptions.safeParse(await this.cache.getJson(cacheKey));
        if (hit.success) return { ok: true, options: hit.data, cached: true };
        const res = await fetch();
        if (!res.ok) return res;
        // Errors are never cached; empty results are, so a dead route isn't re-queried.
        await Promise.all([
          this.cache.setJson(cacheKey, res.value, ttl),
          this.cache.putOptions(res.value, TTL_SECONDS.option),
        ]);
        return { ok: true, options: res.value, cached: false };
      },
      { name: `search.${category}`, run_type: "tool" },
    );
    const promise = run(name).finally(() => this.inflight.delete(name));
    this.inflight.set(name, promise);
    return promise;
  }
}
