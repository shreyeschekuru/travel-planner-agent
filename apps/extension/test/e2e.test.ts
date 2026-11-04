import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";
import { createApiClient } from "../src/worker/api.js";
import { TRIP_KEY, TripController } from "../src/worker/controller.js";
import { createInstallTokenProvider } from "../src/worker/install.js";
import type { TripState } from "../src/worker/trip-state.js";
import { createTripsDb } from "../src/worker/trips-db.js";
import { memoryArea } from "./fake-chrome.js";

/**
 * The worker's real API client, event stream and controller against a running API (fixture
 * mode is fine). Off by default. Run with:
 *   E2E_API_BASE=http://localhost:3000 npm test -w @travellite/extension
 */
const apiBase = process.env.E2E_API_BASE;
const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

async function until(
  read: () => TripState | undefined,
  ok: (s: TripState) => boolean,
  ms = 15_000,
) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const s = read();
    if (s && ok(s)) return s;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out; last state: ${JSON.stringify(read()?.phase)}`);
}

describe.skipIf(!apiBase)("e2e: worker against a running API", () => {
  it("plans, refines with a chip, survives a worker restart, and selects", async () => {
    const local = memoryArea("local", new Set());
    const session = memoryArea("session", new Set());
    const token = createInstallTokenProvider({
      apiBase: apiBase!,
      version: "0.1.0",
      storage: local,
      fetch,
    });
    const make = () =>
      new TripController({
        api: createApiClient({ apiBase: apiBase!, token }),
        token,
        storage: session,
        trips,
      });
    const trips = createTripsDb(new IDBFactory());
    const stored = () => session.data[TRIP_KEY] as TripState | undefined;

    const first = make();
    const started = await first.start({
      origin: "JFK",
      destination: "lisbon-pt",
      departure_date: inDays(45),
      return_date: inDays(50),
      date_flex_days: 0,
      budget_usd: 5000,
      travelers: 2,
      preferences: ["food"],
    });
    expect(started.ok).toBe(true);
    const ready = await until(stored, (s) => s.phase === "ready");
    expect(ready.packages.length).toBeGreaterThanOrEqual(2);
    expect(Object.keys(ready.explanations)).toHaveLength(ready.packages.length);

    const refined = await first.refine({ chip: "more_activities" });
    expect(refined).toMatchObject({ ok: true, value: { changed: true } });
    // Simulate Chrome stopping the worker mid-refinement: a new controller resumes from storage.
    const second = make();
    await second.resume();
    const after = await until(stored, (s) => s.phase === "ready" && s.refinements.count === 1);
    expect(after.refinements.last?.reason).toMatch(/activities a day/);

    const selected = await second.select(after.packages[0]!.id);
    expect(selected.ok).toBe(true);
    expect(await trips.list()).toHaveLength(1);
    expect(stored()).toBeUndefined();
  }, 30_000);
});
