import type { SessionEvent } from "@travellite/schema";
import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it, vi } from "vitest";
import { ApiCallError, type ApiClient } from "../src/worker/api.js";
import { TRIP_KEY, TripController } from "../src/worker/controller.js";
import type { TokenProvider } from "../src/worker/install.js";
import type { EventStreamOptions } from "../src/worker/sse.js";
import type { TripState } from "../src/worker/trip-state.js";
import { createTripsDb } from "../src/worker/trips-db.js";
import { memoryArea } from "./fake-chrome.js";
import { config, explanation, itinerary, pkg } from "./fixtures.js";

const SID = "6f1e2d3c-4b5a-4987-8a6b-5c4d3e2f1a99";

function setup(storage = memoryArea("session", new Set())) {
  const streams: { opts: EventStreamOptions; close: ReturnType<typeof vi.fn> }[] = [];
  const api = {
    eventsUrl: (id: string) => `http://api/v1/sessions/${id}/events`,
    prefetch: vi.fn(async () => undefined),
    createSession: vi.fn(async () => ({ session_id: SID, stream_url: "/x" })),
    refine: vi.fn(),
    select: vi.fn(async () => itinerary(SID)),
  };
  const trips = createTripsDb(new IDBFactory());
  const token = Object.assign(async () => "tok", { reset: async () => {} }) as TokenProvider;
  let now = 0;
  const controller = new TripController({
    api: api as unknown as ApiClient,
    token,
    storage,
    trips,
    openStream: (opts) => {
      const close = vi.fn();
      streams.push({ opts, close });
      return { close, done: Promise.resolve() };
    },
    now: () => now,
  });
  const stored = () => storage.data[TRIP_KEY] as TripState | undefined;
  const emit = async (id: string, e: SessionEvent) => streams.at(-1)!.opts.onEvent(id, e);
  return {
    controller,
    api,
    streams,
    storage,
    stored,
    emit,
    trips,
    tick: (ms: number) => (now += ms),
  };
}

async function runToReady(t: ReturnType<typeof setup>) {
  await t.controller.start(config);
  await t.emit("1-0", { event: "results", data: { category: "flight", count: 10 } });
  await t.emit("2-0", { event: "packages", data: [pkg("a"), pkg("b")] });
  await t.emit("3-0", { event: "explanation", data: explanation("a") });
  await t.emit("4-0", { event: "awaiting_selection", data: {} });
}

describe("TripController", () => {
  it("creates a session, stores events, and closes the stream when the run finishes", async () => {
    const t = setup();
    await runToReady(t);
    expect(t.streams).toHaveLength(1);
    expect(t.streams[0]!.opts.url).toBe(`http://api/v1/sessions/${SID}/events`);
    expect(t.stored()).toMatchObject({ session_id: SID, phase: "ready", last_event_id: "4-0" });
    expect(t.stored()!.packages).toHaveLength(2);
    expect(t.streams[0]!.close).toHaveBeenCalled();
  });

  it("ignores events it has already applied", async () => {
    const t = setup();
    await t.controller.start(config);
    await t.emit("2-0", { event: "results", data: { category: "flight", count: 10 } });
    await t.emit("1-0", { event: "results", data: { category: "flight", count: 99 } });
    expect(t.stored()!.results.flight).toEqual({ count: 10 });
  });

  it("resumes from the last stored event after the worker restarts", async () => {
    const first = setup();
    await first.controller.start(config);
    await first.emit("1-0", { event: "results", data: { category: "flight", count: 10 } });

    // A new worker: same storage, new controller.
    const second = setup(first.storage);
    await second.controller.resume();
    expect(second.streams).toHaveLength(1);
    expect(second.streams[0]!.opts.lastEventId()).toBe("1-0");
  });

  it("does not reconnect a finished trip", async () => {
    const first = setup();
    await runToReady(first);
    const second = setup(first.storage);
    await second.controller.resume();
    expect(second.streams).toHaveLength(0);
  });

  it("reconnects for a changed refinement", async () => {
    const t = setup();
    await runToReady(t);
    const delta = {
      ops: [{ path: "hotel.min_rating" as const, op: "set" as const, value: 4 }],
      reason: "Hotels rated 4+ only",
    };
    t.api.refine.mockResolvedValue({ delta, changed: true });
    expect(await t.controller.refine({ chip: "better_hotel" })).toEqual({
      ok: true,
      value: { reason: "Hotels rated 4+ only", changed: true },
    });
    expect(t.stored()).toMatchObject({ phase: "refining", refinements: { pending: delta } });
    expect(t.streams).toHaveLength(2);
    expect(t.streams[1]!.opts.lastEventId()).toBe("4-0");
    await t.emit("5-0", { event: "refine_applied", data: { delta, changed: true } });
    await t.emit("6-0", { event: "packages", data: [pkg("c")] });
    await t.emit("7-0", { event: "awaiting_selection", data: {} });
    expect(t.stored()).toMatchObject({ phase: "ready", refinements: { count: 1, pending: null } });
  });

  it("keeps the stream closed for an unchanged refinement", async () => {
    const t = setup();
    await runToReady(t);
    t.api.refine.mockResolvedValue({
      delta: { ops: [{ path: "flight.max_stops", op: "set", value: 0 }], reason: "Nonstop" },
      changed: false,
    });
    await t.controller.refine({ chip: "fewer_stops" });
    expect(t.streams).toHaveLength(1);
    expect(t.stored()).toMatchObject({
      phase: "ready",
      refinements: { last: { reason: "Nonstop", changed: false } },
    });
  });

  it("returns the API's refusal and marks an expired session", async () => {
    const t = setup();
    await runToReady(t);
    t.api.refine.mockRejectedValueOnce(
      new ApiCallError(400, {
        code: "INVALID_INPUT",
        message: "Couldn't apply that, try a chip",
        retryable: false,
      }),
    );
    expect(await t.controller.refine({ text: "?" })).toMatchObject({
      ok: false,
      error: { message: "Couldn't apply that, try a chip" },
    });
    t.api.refine.mockRejectedValueOnce(
      new ApiCallError(404, { code: "NOT_FOUND", message: "Session not found", retryable: false }),
    );
    await t.controller.refine({ chip: "fewer_stops" });
    expect(t.stored()).toMatchObject({ phase: "error", error: { code: "SESSION_EXPIRED" } });
  });

  it("saves the itinerary and clears the trip on select", async () => {
    const t = setup();
    await runToReady(t);
    const res = await t.controller.select("a");
    expect(res.ok).toBe(true);
    expect(t.api.select).toHaveBeenCalledWith(SID, "a");
    expect(await t.trips.list()).toHaveLength(1);
    expect(t.stored()).toBeUndefined();
  });

  it("won't select before the trip is ready", async () => {
    const t = setup();
    await t.controller.start(config);
    expect((await t.controller.select("a")).ok).toBe(false);
    expect(t.api.select).not.toHaveBeenCalled();
  });

  it("marks the trip expired when the stream reports the session gone", async () => {
    const t = setup();
    await t.controller.start(config);
    t.streams[0]!.opts.onGone?.(404);
    await t.controller.current();
    expect(t.stored()).toMatchObject({ phase: "error", error: { code: "SESSION_EXPIRED" } });
  });

  it("sends identical prefetches once a minute", async () => {
    const t = setup();
    const req = {
      origin: "JFK",
      destination: "lisbon-pt",
      departure_date: "2027-03-10",
      return_date: "2027-03-15",
      date_flex_days: 0 as const,
      travelers: 2,
    };
    t.controller.prefetch(req);
    t.controller.prefetch(req);
    t.tick(61_000);
    t.controller.prefetch(req);
    expect(t.api.prefetch).toHaveBeenCalledTimes(2);
  });
});
