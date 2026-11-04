import type { Constraints, FlightOption, HotelOption } from "@travellite/schema";
import { describe, expect, it } from "vitest";
import { budgetAdvice } from "../src/core/budget-advice.js";
import { buildConstraints } from "../src/core/constraints.js";
import {
  activeFilters,
  dateRange,
  noFlights,
  noHotels,
  providerFailure,
  type TripContext,
} from "../src/core/diagnose.js";
import { providerMessage } from "../src/providers/resilience.js";

const base = buildConstraints({
  origin: "ATL",
  destination: "amsterdam-nl",
  departure_date: "2026-11-15",
  return_date: "2026-11-17",
  date_flex_days: 0,
  budget_usd: 2000,
  travelers: 2,
  preferences: [],
});
const trip: TripContext = {
  origin: "ATL",
  cityName: "Amsterdam",
  depart: "2026-11-15",
  return: "2026-11-17",
  flexDays: 0,
  travelers: 2,
};
const with_ = (patch: {
  flight?: Partial<Constraints["flight"]>;
  hotel?: Partial<Constraints["hotel"]>;
}): Constraints => ({
  ...base,
  flight: { ...base.flight, ...patch.flight },
  hotel: { ...base.hotel, ...patch.hotel },
});

function flight(price: number, stops: number, depart = "09:00", arrive = "21:00"): FlightOption {
  return {
    id: `duffel:f${price}${stops}`,
    category: "flight",
    title: "x",
    price: { amount: price, currency: "USD" },
    price_basis: "total",
    url: "https://www.google.com/travel/flights?q=x",
    attrs: {
      depart_at: `2026-11-15T${depart}:00`,
      arrive_at: `2026-11-15T${arrive}:00`,
      return_depart_at: "2026-11-17T10:00:00",
      return_arrive_at: "2026-11-17T14:00:00",
      stops,
      duration_min: 500,
      carrier: "XX",
    },
  };
}
function hotel(total: number, rating?: number, km?: number): HotelOption {
  return {
    id: `duffel:h${total}${rating}`,
    category: "hotel",
    title: "Hotel",
    price: { amount: total, currency: "USD" },
    price_basis: "total",
    ...(rating === undefined ? {} : { rating }),
    url: "https://www.google.com/travel/search?q=x",
    attrs: {
      checkin: "2026-11-15",
      checkout: "2026-11-17",
      nights: 2,
      ...(km === undefined ? {} : { km_from_center: km }),
    },
  };
}

describe("dateRange", () => {
  it("formats same-month, cross-month and flexible ranges", () => {
    expect(dateRange("2026-11-15", "2026-11-17")).toBe("Nov 15–17");
    expect(dateRange("2026-11-30", "2026-12-02")).toBe("Nov 30–Dec 2");
    expect(dateRange("2026-11-15", "2026-11-17", 2)).toBe("Nov 15–17 (± 2 days)");
  });
});

describe("providerFailure", () => {
  it("explains an account without access, with no retry and no refinement", () => {
    expect(providerFailure("hotel", "AUTH", trip)).toEqual({
      category: "hotel",
      code: "PROVIDER_ACCESS",
      message:
        "Hotel search isn't available: the hotel provider hasn't enabled access for this account.",
      retryable: false,
      refinable: false,
    });
  });

  it("says nothing was found for the route and dates, and allows a refinement", () => {
    expect(providerFailure("flight", "NOT_FOUND", trip)).toMatchObject({
      message: "No flights found from ATL to Amsterdam for Nov 15–17.",
      retryable: false,
      refinable: true,
    });
  });

  it.each([
    ["TIMEOUT", "The flight search timed out."],
    ["RATE_LIMIT", "Too many flight searches right now. Try again in a minute."],
    ["UNAVAILABLE", "The flight provider isn't responding right now."],
    ["BREAKER_OPEN", "The flight provider isn't responding right now."],
    ["BAD_PAYLOAD", "The flight provider sent a response we couldn't read."],
  ] as const)("offers a retry for %s", (kind, message) => {
    expect(providerFailure("flight", kind, trip)).toMatchObject({
      message,
      retryable: true,
      refinable: false,
    });
  });
});

describe("noFlights", () => {
  it("says none were found when the search came back empty", () => {
    expect(noFlights([], base, trip).message).toBe(
      "No flights found from ATL to Amsterdam for Nov 15–17.",
    );
  });

  it("names the stops limit and the fewest stops available", () => {
    const d = noFlights(
      [flight(900, 2), flight(800, 3)],
      with_({ flight: { max_stops: 1 } }),
      trip,
    );
    expect(d).toMatchObject({
      message: "No flights with at most 1 stop (the fewest available is 2 stops).",
      refinable: true,
    });
  });

  it("names a price cap and the cheapest price", () => {
    const d = noFlights(
      [flight(1240, 0), flight(1500, 0)],
      with_({ flight: { max_price_usd: 900 } }),
      trip,
    );
    expect(d.message).toBe("No flights under $900 for 2 travelers (the cheapest is $1,240).");
  });

  it("names every constraint the closest flight misses", () => {
    const d = noFlights(
      [flight(950, 1, "06:00"), flight(1400, 2, "10:00")],
      with_({ flight: { max_stops: 0, max_price_usd: 900, earliest_depart: "08:00" } }),
      trip,
    );
    // The $950 1-stop 06:00 flight misses stops, price and time; the other misses stops and price.
    expect(d.message).toBe(
      "No nonstop flights (the fewest available is 1 stop). No flights under $900 for 2 travelers (the cheapest is $950).",
    );
  });

  it("names departure and arrival time limits", () => {
    expect(
      noFlights([flight(900, 0, "06:30")], with_({ flight: { earliest_depart: "08:00" } }), trip)
        .message,
    ).toBe("No flights leaving at 08:00 or later (the latest departure is 06:30).");
    expect(
      noFlights(
        [flight(900, 0, "09:00", "23:10")],
        with_({ flight: { latest_arrive: "22:00" } }),
        trip,
      ).message,
    ).toBe("No flights landing by 22:00 (the earliest arrival is 23:10).");
  });
});

describe("noHotels", () => {
  it("says none are available when the search came back empty", () => {
    expect(noHotels([], base, trip).message).toBe(
      "No hotels available in Amsterdam for Nov 15–17.",
    );
  });

  it("names the minimum rating and the highest available", () => {
    expect(
      noHotels([hotel(400, 4.2), hotel(300, 3.9)], with_({ hotel: { min_rating: 4.5 } }), trip)
        .message,
    ).toBe("No hotels rated 4.5+ (the highest rated is 4.2).");
  });

  it("explains unrated results", () => {
    expect(noHotels([hotel(400)], base, trip).message).toBe(
      "No rated hotels found, so none meet the 3.5+ minimum.",
    );
  });

  it("names a nightly price cap and the cheapest per night", () => {
    expect(
      noHotels(
        [hotel(330, 4), hotel(500, 4.5)],
        with_({ hotel: { max_price_per_night_usd: 120 } }),
        trip,
      ).message,
    ).toBe("No hotels under $120 a night (the cheapest is $165 a night).");
  });

  it("names a distance limit and the closest hotel", () => {
    expect(
      noHotels(
        [hotel(330, 4, 1.8), hotel(330, 4, 3)],
        with_({ hotel: { max_km_from_center: 1 } }),
        trip,
      ).message,
    ).toBe("No hotels within 1 km of the center (the closest is 1.8 km).");
  });
});

describe("budget advice", () => {
  it("breaks the cheapest total into flight and hotel, and lists changed filters", () => {
    const c = with_({ hotel: { min_rating: 4.5 } });
    const advice = budgetAdvice(
      {
        flights: [flight(1030, 1)],
        hotels: [hotel(2012, 4.6)],
        activities: [],
        cityCenter: { lat: 0, lng: 0 },
      },
      c,
      [],
    );
    expect(advice).toEqual({
      cheapest_total_usd: 3042,
      driver: "hotel",
      cheapest_flight_usd: 1030,
      cheapest_hotel_usd: 2012,
      nights: 2,
      filters: ["hotels rated 4.5+"],
    });
  });

  it("lists every non-default constraint", () => {
    expect(
      activeFilters(
        with_({ flight: { max_stops: 0, max_price_usd: 900 }, hotel: { max_km_from_center: 2 } }),
      ),
    ).toEqual(["nonstop flights", "flights under $900", "hotels within 2 km of the center"]);
    expect(activeFilters(base)).toEqual([]);
  });
});

describe("providerMessage", () => {
  it("pulls the provider's own error text for logs", () => {
    expect(
      providerMessage({ errors: [{ message: "This feature is not enabled for your account." }] }),
    ).toBe("This feature is not enabled for your account.");
    expect(providerMessage({ message: "Invalid destination" })).toBe("Invalid destination");
  });
});
