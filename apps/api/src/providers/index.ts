import { join } from "node:path";
import { providerModes, type Config, type ProviderMode } from "../config.js";
import type { Cache } from "../store/cache.js";
import type { RedisClient } from "../store/redis.js";
import { SearchService, type SearchProviders } from "../search/search.js";
import { CircuitBreaker } from "./breaker.js";
import { DuffelFlights } from "./duffel-flights.js";
import { DuffelStays } from "./duffel-stays.js";
import { RECORDED_SUBDIR, findFixturesDir, fixtureTransport } from "./fixtures.js";
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

/** Fixture mode replays live recordings first, then the synthetic set. */
const fixturesFor = (dir: string) => fixtureTransport([join(dir, RECORDED_SUBDIR), dir]);

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
  const modes = providerModes(config);
  let fixtures: Transport | undefined;
  const transportFor = (mode: ProviderMode): Transport =>
    overrides.transport ??
    (mode === "live"
      ? fetchTransport
      : (fixtures ??= fixturesFor(config.FIXTURES_DIR ?? findFixturesDir())));
  const duffelToken = config.DUFFEL_ACCESS_TOKEN ?? FIXTURE_SECRET;
  const viatorKey = config.VIATOR_API_KEY ?? FIXTURE_SECRET;
  const sleep = overrides.sleep ? { sleep: overrides.sleep } : {};

  // Flights and hotels share Duffel's rate limit and breaker.
  const duffelBreaker = new CircuitBreaker();
  const duffelBucket = new TokenBucket(redis, "duffel", config.DUFFEL_RATE_PER_SEC);
  const duffel = (timeoutMs: number, mode: ProviderMode) =>
    new ResilientHttp({
      provider: "duffel",
      transport: transportFor(mode),
      breaker: duffelBreaker,
      bucket: duffelBucket,
      timeoutMs,
      ...sleep,
    });
  const viatorHttp = new ResilientHttp({
    provider: "viator",
    transport: transportFor(modes.activities),
    breaker: new CircuitBreaker(),
    bucket: new TokenBucket(redis, "viator", config.VIATOR_RATE_PER_SEC),
    timeoutMs: TIMEOUTS_MS.activities,
    ...sleep,
  });
  // Live Duffel prices need live exchange rates; fixture prices match the recorded rates.
  const fxMode = modes.flights === "live" || modes.hotels === "live" ? "live" : "fixture";
  const fx = new Fx(
    transportFor(fxMode),
    cache,
    undefined,
    fxMode === "fixture" ? "fixture:fx:ecb" : undefined,
  );
  const dropped = (provider: string) => (count: number) => overrides.onDropped?.(provider, count);

  return {
    flights: new DuffelFlights({
      http: duffel(TIMEOUTS_MS.flights, modes.flights),
      fx,
      token: duffelToken,
      supplierTimeoutMs: TIMEOUTS_MS.flightsSupplier,
      onDropped: dropped("duffel.flights"),
    }),
    hotels: new DuffelStays({
      http: duffel(TIMEOUTS_MS.hotels, modes.hotels),
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
  return new SearchService(
    cache,
    createProviders(config, redis, cache, overrides),
    undefined,
    providerModes(config),
  );
}
