// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/popup/App.js";
import { TRIP_KEY } from "../src/worker/controller.js";
import type { WorkerRequest } from "../src/worker/messages.js";
import { initialTrip, reduceTrip } from "../src/worker/trip-state.js";
import { createTripsDb } from "../src/worker/trips-db.js";
import { installFakeChrome } from "./fake-chrome.js";
import { config, itinerary, pkg } from "./fixtures.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const SID = "6f1e2d3c-4b5a-4987-8a6b-5c4d3e2f1a55";
const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

describe("App", () => {
  it("restores the saved draft and saves edits", async () => {
    const chrome = installFakeChrome({
      local: { draft: { origin: "SFO", destination: "rome-it" } },
    });
    render(<App db={createTripsDb(new IDBFactory())} />);
    const origin = (await screen.findByLabelText("From")) as HTMLInputElement;
    expect(origin.value).toBe("SFO");
    expect((screen.getByLabelText("To") as HTMLSelectElement).value).toBe("rome-it");
    fireEvent.change(origin, { target: { value: "lax" } });
    expect((chrome.local.data.draft as { origin: string }).origin).toBe("LAX");
  });

  it("renders the trip from session storage and follows the worker's updates", async () => {
    const searching = initialTrip(SID, config);
    const chrome = installFakeChrome({ session: { [TRIP_KEY]: searching } });
    render(<App db={createTripsDb(new IDBFactory())} />);
    expect(await screen.findByText(/Searching flights, hotels and activities/)).toBeTruthy();

    const ready = [
      { event: "packages", data: [pkg("a"), pkg("b", "upgrade")] },
      { event: "awaiting_selection", data: {} },
    ].reduce((s, e) => reduceTrip(s, e as never), searching);
    await act(() => chrome.session.set({ [TRIP_KEY]: ready }));
    expect(screen.getAllByRole("article")).toHaveLength(2);
    expect(screen.getByRole("region", { name: "Refine this trip" })).toBeTruthy();
  });

  it("asks the worker to select, then shows the saved trip", async () => {
    const db = createTripsDb(new IDBFactory());
    const ready = reduceTrip(
      reduceTrip(initialTrip(SID, config), { event: "packages", data: [pkg("a")] }),
      {
        event: "awaiting_selection",
        data: {},
      },
    );
    const chrome = installFakeChrome({
      session: { [TRIP_KEY]: ready },
      onMessage: async (msg) => {
        const m = msg as WorkerRequest;
        if (m.type !== "select") return { registered: true };
        const saved = itinerary(SID);
        await db.put(saved);
        await chrome.session.remove(TRIP_KEY);
        return { ok: true, value: saved };
      },
    });
    render(<App db={db} />);
    fireEvent.click(await screen.findByRole("button", { name: "Choose this trip" }));
    expect(await screen.findByRole("region", { name: "Saved trip" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Hotel A, 5 nights" })).toBeTruthy();
    expect(chrome.sendMessage).toHaveBeenCalledWith({ type: "select", package_id: "a" });
  });

  it("shows why the background service can't be reached", async () => {
    installFakeChrome({
      onMessage: () => ({
        registered: false,
        error: "Couldn't reach Travellite. Try again shortly.",
      }),
    });
    render(<App db={createTripsDb(new IDBFactory())} />);
    expect((await screen.findByRole("alert")).textContent).toMatch(/Couldn't reach Travellite/);
  });

  it("starts a trip from the form", async () => {
    const chrome = installFakeChrome({
      local: {
        draft: {
          origin: "JFK",
          destination: "lisbon-pt",
          departure_date: inDays(40),
          return_date: inDays(45),
          date_flex_days: 0,
          budget_usd: "4000",
          travelers: "2",
          preferences: [],
        },
      },
      onMessage: (msg) =>
        (msg as WorkerRequest).type === "start"
          ? {
              ok: false,
              error: { code: "RATE_LIMITED", message: "Too many requests", retryable: true },
            }
          : { registered: true },
    });
    render(<App db={createTripsDb(new IDBFactory())} />);
    fireEvent.click(await screen.findByRole("button", { name: "Plan my trip" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Too many requests");
    expect(chrome.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "start" }));
  });
});
