import { CircuitBreaker } from "../src/providers/breaker.js";
import { DuffelFlights } from "../src/providers/duffel-flights.js";
import { DuffelStays } from "../src/providers/duffel-stays.js";
import { Fx } from "../src/providers/fx.js";
import type { Transport } from "../src/providers/http.js";
import { TIMEOUTS_MS } from "../src/providers/index.js";
import { ResilientHttp } from "../src/providers/resilience.js";
import { ViatorActivities } from "../src/providers/viator.js";
import type { JsonCache } from "../src/store/cache.js";

/** In-memory cache so scripts run without Redis. */
export function memoryCache(): JsonCache {
  const m = new Map<string, unknown>();
  return {
    getJson: async <T>(name: string) => (m.has(name) ? (m.get(name) as T) : null),
    setJson: async (name: string, value: unknown) => void m.set(name, value),
  };
}

/** The real adapters over any transport, with no shared rate limit. */
export interface StandaloneOptions {
  timeoutScale?: number;
  sleep?: (ms: number) => Promise<void>;
  onDropped?: (count: number) => void;
}

export function standaloneProviders(
  transport: Transport,
  secrets: { duffel: string; viator: string },
  { timeoutScale = 1, sleep, onDropped }: StandaloneOptions = {},
) {
  const bucket = { take: async () => ({ allowed: true, waitMs: 0 }) };
  const http = (provider: "duffel" | "viator", timeoutMs: number) =>
    new ResilientHttp({
      provider,
      transport,
      breaker: new CircuitBreaker(),
      bucket,
      timeoutMs: timeoutMs * timeoutScale,
      ...(sleep ? { sleep } : {}),
    });
  const dropped = onDropped ? { onDropped } : {};
  const cache = memoryCache();
  const fx = new Fx(transport, cache);
  return {
    flights: new DuffelFlights({
      http: http("duffel", TIMEOUTS_MS.flights),
      fx,
      token: secrets.duffel,
      supplierTimeoutMs: TIMEOUTS_MS.flightsSupplier,
      ...dropped,
    }),
    hotels: new DuffelStays({
      http: http("duffel", TIMEOUTS_MS.hotels),
      fx,
      token: secrets.duffel,
      ...dropped,
    }),
    activities: new ViatorActivities({
      http: http("viator", TIMEOUTS_MS.activities),
      cache,
      apiKey: secrets.viator,
      ...dropped,
    }),
  };
}
