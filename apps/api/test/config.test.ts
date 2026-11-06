import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig, providerModes } from "../src/config.js";
import { createSearch } from "../src/providers/index.js";
import { Cache } from "../src/store/cache.js";
import { TEST_KEYS, testConfig, useRedis } from "./helpers.js";

const env = (vars: Record<string, string>) => ({ INSTALL_TOKEN_KEYS: TEST_KEYS, ...vars });

describe("provider modes", () => {
  it("defaults every provider to fixture", () => {
    expect(providerModes(loadConfig(env({})))).toEqual({
      flights: "fixture",
      hotels: "fixture",
      activities: "fixture",
    });
  });

  it("lets each provider go live on its own in fixture mode", () => {
    const c = loadConfig(env({ FLIGHTS_MODE: "live", DUFFEL_ACCESS_TOKEN: "duffel_test_x" }));
    expect(providerModes(c)).toEqual({
      flights: "live",
      hotels: "fixture",
      activities: "fixture",
    });
  });

  it("PROVIDER_MODE=live overrides the per-provider settings", () => {
    const c = loadConfig(
      env({
        PROVIDER_MODE: "live",
        HOTELS_MODE: "fixture",
        DUFFEL_ACCESS_TOKEN: "duffel_test_x",
        VIATOR_API_KEY: "v",
      }),
    );
    expect(providerModes(c)).toEqual({ flights: "live", hotels: "live", activities: "live" });
  });

  it("requires only the keys the live providers use", () => {
    expect(() => loadConfig(env({ ACTIVITIES_MODE: "live", VIATOR_API_KEY: "v" }))).not.toThrow();
    expect(() => loadConfig(env({ HOTELS_MODE: "live" }))).toThrow(
      "DUFFEL_ACCESS_TOKEN: Required when HOTELS_MODE=live",
    );
    expect(() => loadConfig(env({ ACTIVITIES_MODE: "live" }))).toThrow(
      "VIATOR_API_KEY: Required when ACTIVITIES_MODE=live",
    );
    expect(() => loadConfig(env({ PROVIDER_MODE: "live", VIATOR_API_KEY: "v" }))).toThrow(
      "DUFFEL_ACCESS_TOKEN: Required when PROVIDER_MODE=live",
    );
  });

  it("rejects an unknown mode", () => {
    expect(() => loadConfig(env({ HOTELS_MODE: "on" }))).toThrow("HOTELS_MODE");
  });
});

describe("mixed provider modes", () => {
  const redis = useRedis();
  afterEach(() => vi.unstubAllGlobals());

  it("sends only the live provider to the network and caches it apart from fixtures", async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        urls.push(url);
        return new Response(JSON.stringify({ errors: [{ message: "not enabled" }] }), {
          status: 403,
        });
      }),
    );
    const config = testConfig({
      HOTELS_MODE: "live",
      DUFFEL_ACCESS_TOKEN: "duffel_test_x",
      DUFFEL_RATE_PER_SEC: "100",
      VIATOR_RATE_PER_SEC: "100",
    });
    const cache = new Cache(redis());
    const search = createSearch(config, redis(), cache);
    const depart = new Date(Date.now() + 60 * 86_400_000).toISOString().slice(0, 10);
    const ret = new Date(Date.now() + 65 * 86_400_000).toISOString().slice(0, 10);
    const r = await search.search({
      origin: "JFK",
      destination: "lisbon-pt",
      depart,
      return: ret,
      flex_days: 0,
      travelers: 2,
    });

    expect(r.flights.ok && r.flights.options.length).toBeGreaterThan(0);
    expect(r.activities.ok).toBe(true);
    expect(r.hotels).toEqual({ ok: false, error: expect.objectContaining({ kind: "AUTH" }) });
    // Only Duffel Stays (and live exchange rates, which it needs) reached the network.
    const api = urls.filter((u) => !u.includes("ecb.europa.eu"));
    expect(api.length).toBeGreaterThan(0);
    expect(api.every((u) => u.includes("/stays/"))).toBe(true);
    expect(await cache.getJson(`fixture:flights:JFK:LIS:${depart}:${ret}:2`)).not.toBeNull();
    expect(await cache.getJson(`flights:JFK:LIS:${depart}:${ret}:2`)).toBeNull();
  });
});
