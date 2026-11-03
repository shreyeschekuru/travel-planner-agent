import type { Config } from "../config.js";
import type { Cache } from "../store/cache.js";
import type { RedisClient } from "../store/redis.js";
import { SearchService, type SearchProviders } from "../search/search.js";
import { CircuitBreaker } from "./breaker.js";
import { DuffelFlights } from "./duffel-flights.js";
import { DuffelStays } from "./duffel-stays.js";
import { fixtureTransport, findFixturesDir } from "./fixtures.js";
import { Fx } from "./fx.js";
import { fetchTransport, type Transport } from "./http.js";
import { ResilientHttp } from "./resilience.js";
import { TokenBucket } from "./token-bucket.js";
import { ViatorActivities } from "./viator.js";

/**
 * Per-attempt timeouts. Duffel's offer requests wait on airlines, so flights get the longest
 * budget, with Duffel told to stop waiting on suppliers before we give up.
 */
export const TIMEOUTS_MS = { flights: 7000, flightsSupplier: 5000, hotels: 4000, activities: 2500 };

/** Fixture-mode stand-ins for secrets; they never leave the process. */
const FIXTURE_SECRET = "fixture";

export interface ProviderOverrides {
  transport?: Transport;
  sleep?: (ms: number) => Promise<void>;
  onDropped?: (provider: string, count: number) => void;
}

export function createProviders(
  config: Config,
  redis: RedisClient,
  cache: Cache,
  overrides: ProviderOverrides = {},
): SearchProviders {
  const transport =
    overrides.transport ??
    (config.PROVIDER_MODE === "live"
      ? fetchTransport
      : fixtureTransport(config.FIXTURES_DIR ?? findFixturesDir()));
  const duffelToken = config.DUFFEL_ACCESS_TOKEN ?? FIXTURE_SECRET;
  const viatorKey = config.VIATOR_API_KEY ?? FIXTURE_SECRET;
  const sleep = overrides.sleep ? { sleep: overrides.sleep } : {};

  // Flights and hotels share Duffel's rate limit and breaker.
  const duffelBreaker = new CircuitBreaker();
  const duffelBucket = new TokenBucket(redis, "duffel", config.DUFFEL_RATE_PER_SEC);
  const duffel = (timeoutMs: number) =>
    new ResilientHttp({
      provider: "duffel",
      transport,
      breaker: duffelBreaker,
      bucket: duffelBucket,
      timeoutMs,
      ...sleep,
    });
  const viatorHttp = new ResilientHttp({
    provider: "viator",
    transport,
    breaker: new CircuitBreaker(),
    bucket: new TokenBucket(redis, "viator", config.VIATOR_RATE_PER_SEC),
    timeoutMs: TIMEOUTS_MS.activities,
    ...sleep,
  });
  const fx = new Fx(transport, cache);
  const dropped = (provider: string) => (count: number) => overrides.onDropped?.(provider, count);

  return {
    flights: new DuffelFlights({
      http: duffel(TIMEOUTS_MS.flights),
      fx,
      token: duffelToken,
      supplierTimeoutMs: TIMEOUTS_MS.flightsSupplier,
      onDropped: dropped("duffel.flights"),
    }),
    hotels: new DuffelStays({
      http: duffel(TIMEOUTS_MS.hotels),
      fx,
      token: duffelToken,
      onDropped: dropped("duffel.stays"),
    }),
    activities: new ViatorActivities({
      http: viatorHttp,
      cache,
      apiKey: viatorKey,
      onDropped: dropped("viator"),
    }),
  };
}

export function createSearch(
  config: Config,
  redis: RedisClient,
  cache: Cache,
  overrides: ProviderOverrides = {},
) {
  return new SearchService(cache, createProviders(config, redis, cache, overrides));
}
