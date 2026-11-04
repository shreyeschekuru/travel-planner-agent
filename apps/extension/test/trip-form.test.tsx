// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  TripForm,
  emptyDraft,
  prefetchRequest,
  validateDraft,
  type Draft,
} from "../src/popup/TripForm.js";
import { useState } from "react";

const NOW = new Date("2026-11-03T12:00:00Z");
const now = () => NOW;

const valid: Draft = {
  ...emptyDraft(),
  origin: "JFK",
  destination: "lisbon-pt",
  departure_date: "2027-03-10",
  return_date: "2027-03-15",
  budget_usd: "4000",
  travelers: "2",
};

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function Harness(props: {
  initial: Draft;
  onSubmit?: () => void;
  onPrefetch?: (r: unknown) => void;
}) {
  const [draft, setDraft] = useState(props.initial);
  return (
    <TripForm
      draft={draft}
      onChange={setDraft}
      onSubmit={props.onSubmit ?? (() => {})}
      onPrefetch={props.onPrefetch ?? (() => {})}
      now={now}
    />
  );
}

describe("validateDraft", () => {
  it("accepts a complete trip", () => {
    expect(validateDraft(valid, NOW).config).toMatchObject({
      origin: "JFK",
      budget_usd: 4000,
      travelers: 2,
    });
  });

  it.each<[string, Partial<Draft>, keyof Draft, RegExp]>([
    ["return before departure", { return_date: "2027-03-01" }, "return_date", /after departure/],
    [
      "a past departure",
      { departure_date: "2026-01-01", return_date: "2026-01-05" },
      "departure_date",
      /past/,
    ],
    [
      "too far ahead",
      { departure_date: "2028-03-10", return_date: "2028-03-15" },
      "departure_date",
      /365/,
    ],
    ["a low budget", { budget_usd: "50" }, "budget_usd", /\$100/],
    ["10 travelers", { travelers: "10" }, "travelers", /1 to 9/],
    ["a bad airport code", { origin: "J1" }, "origin", /3-letter/],
  ])("rejects %s", (_l, change, field, message) => {
    expect(validateDraft({ ...valid, ...change }, NOW).errors[field]).toMatch(message);
  });

  it("builds a prefetch request before budget is filled in", () => {
    expect(prefetchRequest({ ...valid, budget_usd: "" }, NOW)).toEqual({
      origin: "JFK",
      destination: "lisbon-pt",
      departure_date: "2027-03-10",
      return_date: "2027-03-15",
      date_flex_days: 0,
      travelers: 2,
    });
    expect(prefetchRequest({ ...valid, destination: "" }, NOW)).toBeNull();
  });
});

describe("TripForm", () => {
  it("keeps submit disabled until every field is valid", () => {
    render(<Harness initial={{ ...valid, budget_usd: "" }} />);
    const submit = screen.getByRole("button", { name: "Plan my trip" });
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Total budget (USD)"), { target: { value: "4000" } });
    expect((submit as HTMLButtonElement).disabled).toBe(false);
  });

  it("shows a field's error after it loses focus", () => {
    render(<Harness initial={{ ...valid, origin: "" }} />);
    const origin = screen.getByLabelText("From");
    expect(screen.queryByText(/3-letter/)).toBeNull();
    fireEvent.blur(origin);
    expect(screen.getByText(/3-letter/)).toBeTruthy();
    expect(origin.getAttribute("aria-invalid")).toBe("true");
    expect(origin.getAttribute("aria-describedby")).toBeTruthy();
  });

  it("submits the parsed config", async () => {
    const onSubmit = vi.fn();
    render(<Harness initial={valid} onSubmit={onSubmit} />);
    fireEvent.click(screen.getByRole("button", { name: "Food" }));
    fireEvent.submit(screen.getByRole("form", { name: "Plan a trip" }));
    await vi.waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit.mock.calls[0]![0]).toMatchObject({ preferences: ["food"], budget_usd: 4000 });
  });

  it("prefetches 800 ms after the route and dates become valid, once", () => {
    vi.useFakeTimers();
    const onPrefetch = vi.fn();
    render(<Harness initial={{ ...valid, destination: "" }} onPrefetch={onPrefetch} />);
    fireEvent.change(screen.getByLabelText("To"), { target: { value: "lisbon-pt" } });
    vi.advanceTimersByTime(799);
    expect(onPrefetch).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onPrefetch).toHaveBeenCalledTimes(1);
    // Budget doesn't affect prefetch, so typing it doesn't send another.
    fireEvent.change(screen.getByLabelText("Total budget (USD)"), { target: { value: "5000" } });
    vi.advanceTimersByTime(2000);
    expect(onPrefetch).toHaveBeenCalledTimes(1);
  });

  it("makes interests toggle buttons with pressed state", () => {
    render(<Harness initial={valid} />);
    const food = screen.getByRole("button", { name: "Food" });
    expect(food.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(food);
    expect(food.getAttribute("aria-pressed")).toBe("true");
  });
});
