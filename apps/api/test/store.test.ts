import type { SessionRecord } from "@travellite/schema";
import { describe, expect, it } from "vitest";
import { Cache } from "../src/store/cache.js";
import { EventStore } from "../src/store/events.js";
import { keys } from "../src/store/keys.js";
import { SessionStore } from "../src/store/sessions.js";
import { useRedis } from "./helpers.js";

const redis = useRedis();

const session: SessionRecord = {
  id: "7c1b8f5e-3a2d-4c6b-9e8f-1a2b3c4d5e6f",
  install_id: "a".repeat(32),
  status: "searching",
  config: {
    origin: "ATL",
    destination: "paris-fr",
    departure_date: "2026-12-01",
    return_date: "2026-12-07",
    date_flex_days: 0,
    budget_usd: 3000,
    travelers: 2,
    preferences: ["food"],
  },
  constraints: {
    dates: { depart: "2026-12-01", return: "2026-12-07", flex_days: 0 },
    budget: { total_usd: 3000, tolerance_pct: 5 },
    flight: { max_stops: 1 },
    hotel: { min_rating: 3.5 },
    activities: { interests: ["food"], max_per_day: 2 },
    travelers: 2,
  },
  delta_history: [],
  results: {},
  packages: [],
  explanations: [],
  created_at: "2026-10-30T12:00:00Z",
};

describe("SessionStore", () => {
  it("round-trips a session with a TTL", async () => {
    const store = new SessionStore(redis(), 120);
    await store.put(session);
    expect(await store.get(session.id)).toEqual(session);
    const ttl = await redis().ttl(keys.session(session.id));
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(120);
  });

  it("only returns a session to the install that owns it", async () => {
    const store = new SessionStore(redis());
    await store.put(session);
    expect(await store.getOwned(session.id, session.install_id)).not.toBeNull();
    expect(await store.getOwned(session.id, "b".repeat(32))).toBeNull();
  });

  it("refuses to write an invalid record", async () => {
    const store = new SessionStore(redis());
    await expect(store.put({ ...session, status: "bogus" } as never)).rejects.toThrow();
  });

  it("treats a corrupted record as missing", async () => {
    await redis().set(keys.session(session.id), JSON.stringify({ id: session.id }));
    expect(await new SessionStore(redis()).get(session.id)).toBeNull();
  });

  it("deletes", async () => {
    const store = new SessionStore(redis());
    await store.put(session);
    await store.delete(session.id);
    expect(await store.get(session.id)).toBeNull();
  });
});

describe("EventStore", () => {
  const sid = session.id;

  it("appends in order and resumes after an id", async () => {
    const events = new EventStore(redis());
    const a = await events.append(sid, {
      event: "results",
      data: { category: "flight", count: 3 },
    });
    const b = await events.append(sid, { event: "results", data: { category: "hotel", count: 5 } });
    await events.append(sid, { event: "awaiting_selection", data: {} });

    const all = await events.readAfter(sid);
    expect(all.map((e) => e.event.event)).toEqual(["results", "results", "awaiting_selection"]);
    expect(all[0]?.id).toBe(a);

    const resumed = await events.readAfter(sid, b);
    expect(resumed.map((e) => e.event.event)).toEqual(["awaiting_selection"]);
    expect(await events.readAfter(sid, resumed[0]!.id)).toEqual([]);
  });

  it("rejects invalid events", async () => {
    const events = new EventStore(redis());
    await expect(
      events.append(sid, { event: "results", data: { category: "car" } } as never),
    ).rejects.toThrow();
  });

  it("sets a TTL on the stream", async () => {
    const events = new EventStore(redis(), 300);
    await events.append(sid, { event: "awaiting_selection", data: {} });
    expect(await redis().ttl(keys.events(sid))).toBeGreaterThan(0);
  });

  it("tail returns events that arrive while waiting", async () => {
    const events = new EventStore(redis());
    const first = await events.append(sid, { event: "awaiting_selection", data: {} });
    const blocking = redis().duplicate();
    try {
      const waiting = events.tail(blocking, sid, first, 2000);
      await new Promise((r) => setTimeout(r, 50));
      await events.append(sid, { event: "results", data: { category: "activity", count: 1 } });
      const got = await waiting;
      expect(got.map((e) => e.event.event)).toEqual(["results"]);
    } finally {
      blocking.disconnect();
    }
  });

  it("tail times out with no events", async () => {
    const events = new EventStore(redis());
    const first = await events.append(sid, { event: "awaiting_selection", data: {} });
    const blocking = redis().duplicate();
    try {
      expect(await events.tail(blocking, sid, first, 100)).toEqual([]);
    } finally {
      blocking.disconnect();
    }
  });
});

describe("Cache", () => {
  const hotel = {
    id: "hotels:h1",
    category: "hotel" as const,
    title: "Hotel Lutetia",
    price: { amount: 210, currency: "USD" as const },
    price_basis: "per_night" as const,
    rating: 4.6,
    url: "https://www.booking.example/h1",
    attrs: { checkin: "2026-12-01", checkout: "2026-12-07", nights: 6 },
  };

  it("stores JSON with a TTL", async () => {
    const cache = new Cache(redis());
    await cache.setJson("x", { a: 1 }, 60);
    expect(await cache.getJson("x")).toEqual({ a: 1 });
    expect(await cache.getJson("missing")).toBeNull();
  });

  it("stores and fetches options by id", async () => {
    const cache = new Cache(redis());
    await cache.putOptions([hotel], 60);
    const got = await cache.getOptions(["hotels:h1", "hotels:nope"]);
    expect(got.get("hotels:h1")).toEqual(hotel);
    expect(got.has("hotels:nope")).toBe(false);
  });
});
