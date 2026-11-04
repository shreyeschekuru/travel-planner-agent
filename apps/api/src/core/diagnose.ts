import type {
  Constraints,
  ErrorCode,
  FlightOption,
  HotelOption,
  OptionCategory,
  ProviderErrorKind,
} from "@travellite/schema";
import { DEFAULTS } from "./constraints.js";
import { flightTotal, hotelTotal } from "./optimizer.js";

/** What the user asked for, in words the messages can use. */
export interface TripContext {
  origin: string;
  cityName: string;
  depart: string;
  return: string;
  flexDays: number;
  travelers: number;
}

export interface Diagnosis {
  code: ErrorCode;
  message: string;
  retryable: boolean;
  /** A refinement (dates, a constraint) could fix it, so the session stays open. */
  refinable: boolean;
  category: OptionCategory;
}

const usd = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const hhmm = (iso: string) => iso.slice(11, 16);

function day(iso: string) {
  const d = new Date(`${iso}T00:00:00Z`);
  return {
    month: d.toLocaleDateString("en-US", { month: "short", timeZone: "UTC" }),
    date: d.getUTCDate(),
  };
}

/** "Nov 15–17", "Nov 30–Dec 2", with "(± 2 days)" for flexible dates. */
export function dateRange(depart: string, ret: string, flexDays = 0): string {
  const a = day(depart);
  const b = day(ret);
  const range =
    a.month === b.month
      ? `${a.month} ${a.date}–${b.date}`
      : `${a.month} ${a.date}–${b.month} ${b.date}`;
  return flexDays ? `${range} (± ${plural(flexDays, "day")})` : range;
}

const NOUN: Record<OptionCategory, string> = {
  flight: "flight",
  hotel: "hotel",
  activity: "activity",
};
const PROVIDER: Record<OptionCategory, string> = {
  flight: "flight provider",
  hotel: "hotel provider",
  activity: "activities provider",
};

/** A provider call failed (design.md §7): say what happened and whether retrying can help. */
export function providerFailure(
  category: OptionCategory,
  kind: ProviderErrorKind,
  t: TripContext,
): Diagnosis {
  const base = { category };
  const dates = dateRange(t.depart, t.return, t.flexDays);
  switch (kind) {
    case "NOT_FOUND":
      return {
        ...base,
        code: "NOT_FOUND",
        message:
          category === "flight"
            ? `No flights found from ${t.origin} to ${t.cityName} for ${dates}.`
            : category === "hotel"
              ? `No hotels found in ${t.cityName} for ${dates}.`
              : `No activities found in ${t.cityName}.`,
        retryable: false,
        refinable: true,
      };
    case "AUTH":
      return {
        ...base,
        code: "PROVIDER_ACCESS",
        message: `${capitalize(NOUN[category])} search isn't available: the ${PROVIDER[category]} hasn't enabled access for this account.`,
        retryable: false,
        refinable: false,
      };
    case "TIMEOUT":
      return {
        ...base,
        code: "PROVIDER_TIMEOUT",
        message: `The ${NOUN[category]} search timed out.`,
        retryable: true,
        refinable: false,
      };
    case "RATE_LIMIT":
      return {
        ...base,
        code: "PROVIDER_RATE_LIMIT",
        message: `Too many ${NOUN[category]} searches right now. Try again in a minute.`,
        retryable: true,
        refinable: false,
      };
    case "BAD_PAYLOAD":
      return {
        ...base,
        code: "PROVIDER_BAD_PAYLOAD",
        message: `The ${PROVIDER[category]} sent a response we couldn't read.`,
        retryable: true,
        refinable: false,
      };
    case "UNAVAILABLE":
    case "BREAKER_OPEN":
      return {
        ...base,
        code: "NETWORK_ERROR",
        message: `The ${PROVIDER[category]} isn't responding right now.`,
        retryable: true,
        refinable: false,
      };
  }
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

interface Check<O> {
  fails: (o: O) => boolean;
  /** Describes the constraint and the closest value actually available. */
  describe: (options: O[]) => string;
}

/**
 * Names the constraint(s) that ruled out every option: those the closest option fails.
 * With nothing to filter, says nothing was found at all.
 */
function explain<O>(options: O[], checks: (Check<O> | null)[], none: string, noun: string): string {
  if (options.length === 0) return none;
  const active = checks.filter((c): c is Check<O> => c !== null);
  const closest = options
    .map((o) => active.filter((c) => c.fails(o)))
    .sort((a, b) => a.length - b.length)[0]!;
  if (closest.length === 0) return `No ${noun} match this trip.`;
  return `${closest.map((c) => c.describe(options)).join(". ")}.`;
}

export function noFlights(flights: FlightOption[], c: Constraints, t: TripContext): Diagnosis {
  const f = c.flight;
  const message = explain<FlightOption>(
    flights,
    [
      {
        fails: (o) => o.attrs.stops > f.max_stops,
        describe: (all) => {
          const fewest = Math.min(...all.map((o) => o.attrs.stops));
          const want =
            f.max_stops === 0
              ? "nonstop flights"
              : `flights with at most ${plural(f.max_stops, "stop")}`;
          return `No ${want} (the fewest available is ${plural(fewest, "stop")})`;
        },
      },
      f.max_price_usd === undefined
        ? null
        : {
            fails: (o) => flightTotal(o, c.travelers) > f.max_price_usd!,
            describe: (all) =>
              `No flights under ${usd(f.max_price_usd!)} for ${plural(c.travelers, "traveler")} (the cheapest is ${usd(Math.min(...all.map((o) => flightTotal(o, c.travelers))))})`,
          },
      f.earliest_depart === undefined
        ? null
        : {
            fails: (o) => hhmm(o.attrs.depart_at) < f.earliest_depart!,
            describe: (all) =>
              `No flights leaving at ${f.earliest_depart} or later (the latest departure is ${all
                .map((o) => hhmm(o.attrs.depart_at))
                .sort()
                .at(-1)})`,
          },
      f.latest_arrive === undefined
        ? null
        : {
            fails: (o) => hhmm(o.attrs.arrive_at) > f.latest_arrive!,
            describe: (all) =>
              `No flights landing by ${f.latest_arrive} (the earliest arrival is ${all.map((o) => hhmm(o.attrs.arrive_at)).sort()[0]})`,
          },
    ],
    `No flights found from ${t.origin} to ${t.cityName} for ${dateRange(t.depart, t.return, t.flexDays)}.`,
    "flights",
  );
  return { code: "NOT_FOUND", message, retryable: false, refinable: true, category: "flight" };
}

export function noHotels(hotels: HotelOption[], c: Constraints, t: TripContext): Diagnosis {
  const h = c.hotel;
  const perNight = (o: HotelOption) => hotelTotal(o) / o.attrs.nights;
  const message = explain<HotelOption>(
    hotels,
    [
      h.min_rating > 0
        ? {
            fails: (o) => (o.rating ?? 0) < h.min_rating,
            describe: (all) => {
              const rated = all.flatMap((o) => (o.rating === undefined ? [] : [o.rating]));
              return rated.length
                ? `No hotels rated ${h.min_rating}+ (the highest rated is ${Math.max(...rated).toFixed(1)})`
                : `No rated hotels found, so none meet the ${h.min_rating}+ minimum`;
            },
          }
        : null,
      h.max_price_per_night_usd === undefined
        ? null
        : {
            fails: (o) => perNight(o) > h.max_price_per_night_usd!,
            describe: (all) =>
              `No hotels under ${usd(h.max_price_per_night_usd!)} a night (the cheapest is ${usd(Math.min(...all.map(perNight)))} a night)`,
          },
      h.max_km_from_center === undefined
        ? null
        : {
            fails: (o) => (o.attrs.km_from_center ?? Infinity) > h.max_km_from_center!,
            describe: (all) => {
              const known = all.flatMap((o) =>
                o.attrs.km_from_center === undefined ? [] : [o.attrs.km_from_center],
              );
              return known.length
                ? `No hotels within ${h.max_km_from_center} km of the center (the closest is ${Math.min(...known).toFixed(1)} km)`
                : `No hotels with a known distance from the center`;
            },
          },
    ],
    `No hotels available in ${t.cityName} for ${dateRange(t.depart, t.return, t.flexDays)}.`,
    "hotels",
  );
  return { code: "NOT_FOUND", message, retryable: false, refinable: true, category: "hotel" };
}

/** Flights and hotels both exist and pass the constraints, but never on the same dates. */
export function noMatchingDates(t: TripContext): Diagnosis {
  return {
    code: "NOT_FOUND",
    message: `Flights and hotels were found, but not for the same dates around ${dateRange(t.depart, t.return)}.`,
    retryable: false,
    refinable: true,
    category: "hotel",
  };
}

/** Constraints the user changed from the defaults, as short phrases for budget advice. */
export function activeFilters(c: Constraints): string[] {
  const out: string[] = [];
  if (c.flight.max_stops !== DEFAULTS.max_stops) {
    out.push(
      c.flight.max_stops === 0
        ? "nonstop flights"
        : `flights with at most ${plural(c.flight.max_stops, "stop")}`,
    );
  }
  if (c.flight.max_price_usd !== undefined)
    out.push(`flights under ${usd(c.flight.max_price_usd)}`);
  if (c.flight.earliest_depart) out.push(`leaving at ${c.flight.earliest_depart} or later`);
  if (c.flight.latest_arrive) out.push(`landing by ${c.flight.latest_arrive}`);
  if (c.hotel.min_rating !== DEFAULTS.min_rating) out.push(`hotels rated ${c.hotel.min_rating}+`);
  if (c.hotel.max_price_per_night_usd !== undefined)
    out.push(`hotels under ${usd(c.hotel.max_price_per_night_usd)} a night`);
  if (c.hotel.max_km_from_center !== undefined)
    out.push(`hotels within ${c.hotel.max_km_from_center} km of the center`);
  return out;
}
