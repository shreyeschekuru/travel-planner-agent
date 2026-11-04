// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MyTrips } from "../src/popup/MyTrips.js";
import { PackagesView } from "../src/popup/PackagesView.js";
import { RefineBar } from "../src/popup/RefineBar.js";
import { initialTrip, reduceTrip, type TripState } from "../src/worker/trip-state.js";
import { createTripsDb } from "../src/worker/trips-db.js";
import { config, explanation, itinerary, pkg } from "./fixtures.js";

afterEach(cleanup);

const SID = "6f1e2d3c-4b5a-4987-8a6b-5c4d3e2f1a77";

function trip(events: Parameters<typeof reduceTrip>[1][]): TripState {
  return events.reduce(reduceTrip, initialTrip(SID, config));
}

const view = (t: TripState, over: Partial<Parameters<typeof PackagesView>[0]> = {}) =>
  render(
    <PackagesView
      trip={t}
      onSelect={() => {}}
      selecting={null}
      onRetry={() => {}}
      onEdit={() => {}}
      {...over}
    />,
  );

describe("PackagesView", () => {
  it("shows cards as packages arrive and fills explanations as they stream", () => {
    const t = trip([
      { event: "packages", data: [pkg("a"), pkg("b", "upgrade", 3900)] },
      { event: "explanation", data: explanation("a") },
    ]);
    view(t);
    const cards = screen.getAllByRole("article");
    expect(cards).toHaveLength(2);
    expect(within(cards[0]!).getByText("Headline for a")).toBeTruthy();
    expect(within(cards[0]!).getByText("Total $3,500, within your $4,000 budget")).toBeTruthy();
    expect(within(cards[1]!).getByText("Writing a summary…")).toBeTruthy();
    expect(within(cards[1]!).getByText("Upgrade")).toBeTruthy();
    expect(within(cards[1]!).getByText("$3,900")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toMatch(/Writing summaries/);
  });

  it("enables Choose only once the trip is ready", () => {
    const onSelect = vi.fn();
    const explaining = trip([{ event: "packages", data: [pkg("a")] }]);
    const { rerender } = view(explaining, { onSelect });
    const button = () =>
      screen.getByRole("button", { name: "Choose this trip" }) as HTMLButtonElement;
    expect(button().disabled).toBe(true);
    rerender(
      <PackagesView
        trip={reduceTrip(explaining, { event: "awaiting_selection", data: {} })}
        onSelect={onSelect}
        selecting={null}
        onRetry={() => {}}
        onEdit={() => {}}
      />,
    );
    fireEvent.click(button());
    expect(onSelect).toHaveBeenCalledWith("a");
  });

  it("explains missing activities without repeating flight or hotel failures", () => {
    view(
      trip([
        { event: "degraded", data: { category: "activity", error_kind: "AUTH" } },
        { event: "degraded", data: { category: "hotel", error_kind: "AUTH" } },
        { event: "packages", data: [pkg("a")] },
      ]),
    );
    expect(
      screen.getByText(
        "Activity search isn't enabled for this account, so packages don't include activities.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/hotel/i, { selector: ".banner.warn" })).toBeNull();
  });

  it("breaks down budget advice and names the filters behind it", () => {
    view(
      trip([
        {
          event: "budget_advice",
          data: {
            cheapest_total_usd: 5210,
            driver: "hotel",
            cheapest_flight_usd: 1830,
            cheapest_hotel_usd: 3380,
            nights: 5,
            filters: ["hotels rated 4.5+"],
            nearest_fitting_dates: { depart: "2027-03-12", return: "2027-03-17", total_usd: 3980 },
          },
        },
      ]),
    );
    const advice = document.querySelector(".banner.advice")!.textContent!.replace(/\s+/g, " ");
    expect(advice).toContain(
      "Nothing fits your $4,000 budget. The cheapest flight + hotel for Mar 10 – Mar 15 is $5,210: flight $1,830 for 2 travelers + hotel $3,380 for 5 nights.",
    );
    expect(advice).toContain("That's with your filters: hotels rated 4.5+.");
    expect(advice).toContain("Mar 12 – Mar 17 would fit at $3,980.");
  });

  it("offers a retry for retryable errors", () => {
    const onRetry = vi.fn();
    view(
      trip([
        {
          event: "error",
          data: {
            code: "PROVIDER_TIMEOUT",
            message: "The flight search timed out.",
            retryable: true,
          },
        },
      ]),
      { onRetry },
    );
    expect(screen.getByRole("alert").textContent).toMatch(/The flight search timed out/);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onRetry).toHaveBeenCalled();
  });

  it("shows a constraint failure without a retry button", () => {
    view(
      trip([
        {
          event: "error",
          data: {
            code: "NOT_FOUND",
            message: "No hotels rated 5+ (the highest rated is 4.6).",
            retryable: false,
            refinable: true,
            category: "hotel",
          },
        },
      ]),
    );
    expect(screen.getByRole("alert").textContent).toMatch(
      /No hotels rated 5\+ \(the highest rated is 4\.6\)/,
    );
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    expect(screen.getByRole("button", { name: "Change trip" })).toBeTruthy();
  });

  it("marks only the parts a refinement is updating", () => {
    const ready = trip([
      { event: "packages", data: [pkg("a")] },
      { event: "awaiting_selection", data: {} },
    ]);
    const refining = reduceTrip(ready, {
      event: "refine_applied",
      data: {
        delta: {
          ops: [{ path: "hotel.min_rating", op: "set", value: 4 }],
          reason: "Hotels rated 4+ only",
        },
        changed: true,
      },
    });
    const { container } = view(refining);
    const busy = [...container.querySelectorAll(".part[aria-busy='true']")].map(
      (e) => e.querySelector("h3")?.textContent ?? "total",
    );
    expect(busy.sort()).toEqual(["Hotel", "total"]);
    expect(screen.getByRole("status").textContent).toBe("Updating: Hotels rated 4+ only");
  });

  it("shows the refined budget and dates in the summary", () => {
    const ready = trip([{ event: "awaiting_selection", data: {} }]);
    view(
      reduceTrip(ready, {
        event: "refine_applied",
        data: {
          delta: {
            ops: [
              { path: "budget.total_usd", op: "set", value: 5000 },
              { path: "dates.depart", op: "add", value: 1 },
              { path: "dates.return", op: "add", value: 1 },
            ],
            reason: "x",
          },
          changed: true,
        },
      }),
    );
    expect(screen.getByText(/Mar 11 – Mar 16 · 2 travelers · \$5,000/)).toBeTruthy();
  });
});

describe("RefineBar", () => {
  const ready = () =>
    trip([
      { event: "packages", data: [pkg("a")] },
      { event: "awaiting_selection", data: {} },
    ]);

  it("sends chips and text, and shows the applied change", async () => {
    const onRefine = vi.fn(async () => null);
    const t = reduceTrip(ready(), {
      event: "refine_applied",
      data: {
        delta: {
          ops: [{ path: "flight.max_stops", op: "set", value: 0 }],
          reason: "Nonstop flights only",
        },
        changed: true,
      },
    });
    const { rerender } = render(<RefineBar trip={ready()} onRefine={onRefine} />);
    fireEvent.click(screen.getByRole("button", { name: "Fewer stops" }));
    expect(onRefine).toHaveBeenCalledWith({ chip: "fewer_stops" });
    await vi.waitFor(() =>
      expect(
        (screen.getByRole("button", { name: "Fewer stops" }) as HTMLButtonElement).disabled,
      ).toBe(false),
    );

    fireEvent.change(screen.getByLabelText("Describe a change"), {
      target: { value: "  hotels under 150  " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(onRefine).toHaveBeenLastCalledWith({ text: "hotels under 150" });

    rerender(<RefineBar trip={{ ...t, phase: "ready" }} onRefine={onRefine} />);
    expect(screen.getByText("Nonstop flights only")).toBeTruthy();
    expect(screen.getByText(/1 of 10 refinements used/)).toBeTruthy();
  });

  it("shows the API's refusal", async () => {
    render(<RefineBar trip={ready()} onRefine={async () => "Couldn't apply that, try a chip"} />);
    fireEvent.change(screen.getByLabelText("Describe a change"), {
      target: { value: "what's the weather" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(await screen.findByText("Couldn't apply that, try a chip")).toBeTruthy();
  });

  it("limits text to 200 characters", () => {
    render(<RefineBar trip={ready()} onRefine={async () => null} />);
    expect(screen.getByLabelText("Describe a change").getAttribute("maxlength")).toBe("200");
  });

  it("disables everything after 10 refinements and while one is running", () => {
    const used = { ...ready(), refinements: { count: 10, last: null, pending: null } };
    const { rerender } = render(<RefineBar trip={used} onRefine={async () => null} />);
    expect(screen.getAllByRole("button").every((b) => (b as HTMLButtonElement).disabled)).toBe(
      true,
    );
    expect(screen.getByText(/You've used all 10 refinements/)).toBeTruthy();
    rerender(<RefineBar trip={{ ...ready(), phase: "refining" }} onRefine={async () => null} />);
    expect(
      (screen.getByRole("button", { name: "Cheaper hotel" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});

describe("MyTrips", () => {
  async function withTrips(...trips: Parameters<typeof itinerary>[]) {
    const db = createTripsDb(new IDBFactory());
    for (const args of trips) await db.put(itinerary(...args));
    return db;
  }

  it("lists trips, opens one, and opens links in a new tab", async () => {
    const db = await withTrips([SID]);
    const openTab = vi.fn();
    render(<MyTrips db={db} openTab={openTab} onPlanAnother={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: /Lisbon/ }));
    fireEvent.click(screen.getByRole("link", { name: "Hotel A, 5 nights" }));
    expect(openTab).toHaveBeenCalledWith("https://www.google.com/travel/search?q=x");
  });

  it("renders links off the allowlist as plain text", async () => {
    const bad = itinerary(SID);
    bad.selections.hotel = { url: "https://evil.example/phish", summary: "Sketchy hotel" };
    const db = createTripsDb(new IDBFactory());
    await db.put(bad);
    render(<MyTrips db={db} initialId={SID} openTab={() => {}} onPlanAnother={() => {}} />);
    expect(await screen.findByText("Sketchy hotel")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Sketchy hotel" })).toBeNull();
  });

  it("marks a trip booked and deletes it", async () => {
    const db = await withTrips([SID]);
    vi.stubGlobal("confirm", () => true);
    render(<MyTrips db={db} initialId={SID} openTab={() => {}} onPlanAnother={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Mark as booked" }));
    expect(await screen.findByText("Booked")).toBeTruthy();
    expect((await db.list())[0]!.status).toBe("booked");
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(await screen.findByText(/No saved trips yet/)).toBeTruthy();
    expect(await db.list()).toEqual([]);
    vi.unstubAllGlobals();
  });

  it("starts a new plan", async () => {
    const onPlanAnother = vi.fn();
    render(<MyTrips db={await withTrips()} onPlanAnother={onPlanAnother} />);
    fireEvent.click(await screen.findByRole("button", { name: "Plan another trip" }));
    expect(onPlanAnother).toHaveBeenCalled();
  });
});
