import { createHash } from "node:crypto";
import type {
  ActivityOption,
  Constraints,
  FlightOption,
  HotelOption,
  LatLng,
  PackageLabel,
  ScoreBreakdown,
  TripPackage,
} from "@travellite/schema";
import { haversineKm } from "../providers/normalize.js";

/** Score weights (design.md §5.4). Tuned against fixtures; must sum to 1. */
export const DEFAULT_WEIGHTS: ScoreBreakdown = {
  cost_fit: 0.3,
  flight_convenience: 0.2,
  hotel_location: 0.15,
  rating: 0.2,
  pref_match: 0.15,
};

export interface OptimizerInput {
  flights: FlightOption[];
  hotels: HotelOption[];
  /** Empty when the activities category is degraded; packages are built without them. */
  activities: ActivityOption[];
  cityCenter: LatLng;
}

export type OptimizeResult =
  | { kind: "packages"; packages: TripPackage[] }
  /** Flights and hotels exist that pass every constraint except the budget. */
  | { kind: "over_budget" }
  /** Nothing in this category passes the non-budget constraints. */
  | { kind: "no_options"; category: "flight" | "hotel" };

const round2 = (n: number) => Math.round(n * 100) / 100;
const clamp01 = (n: number) => Math.min(1, Math.max(0, n));
const day = (iso: string) => iso.slice(0, 10);
const hhmm = (iso: string) => iso.slice(11, 16);

export function flightTotal(f: FlightOption, travelers: number): number {
  return f.price_basis === "per_person" ? f.price.amount * travelers : f.price.amount;
}
export function hotelTotal(h: HotelOption): number {
  return h.price_basis === "per_night" ? h.price.amount * h.attrs.nights : h.price.amount;
}
export function activityTotal(a: ActivityOption, travelers: number): number {
  return a.price_basis === "per_person" ? a.price.amount * travelers : a.price.amount;
}

/** The date pair a flight covers: outbound departure day and return departure day. */
const flightPair = (f: FlightOption) =>
  `${day(f.attrs.depart_at)}|${day(f.attrs.return_depart_at)}`;
const hotelPair = (h: HotelOption) => `${h.attrs.checkin}|${h.attrs.checkout}`;

export function flightPasses(f: FlightOption, c: Constraints): boolean {
  const { max_stops, max_price_usd, earliest_depart, latest_arrive } = c.flight;
  if (f.attrs.stops > max_stops) return false;
  if (max_price_usd !== undefined && flightTotal(f, c.travelers) > max_price_usd) return false;
  if (earliest_depart && hhmm(f.attrs.depart_at) < earliest_depart) return false;
  if (latest_arrive && hhmm(f.attrs.arrive_at) > latest_arrive) return false;
  return true;
}

export function hotelPasses(h: HotelOption, c: Constraints): boolean {
  const { min_rating, max_price_per_night_usd, max_km_from_center } = c.hotel;
  // Unrated hotels can't be shown to meet a minimum rating.
  if (min_rating > 0 && (h.rating ?? 0) < min_rating) return false;
  if (
    max_price_per_night_usd !== undefined &&
    hotelTotal(h) / h.attrs.nights > max_price_per_night_usd
  ) {
    return false;
  }
  if (
    max_km_from_center !== undefined &&
    (h.attrs.km_from_center ?? Infinity) > max_km_from_center
  ) {
    return false;
  }
  return true;
}

export function activityPasses(a: ActivityOption, c: Constraints): boolean {
  const max = c.activities.max_price_each_usd;
  return max === undefined || a.price.amount <= max;
}

/** 1 within 85–100% of budget; less for leaving money unused or going into the tolerance. */
export function costFit(total: number, budget: number, tolerancePct: number): number {
  const r = total / budget;
  if (r <= 0.85) return clamp01(0.4 + 0.6 * (r / 0.85));
  if (r <= 1) return 1;
  return clamp01(1 - (r - 1) / (tolerancePct / 100 || 0.01) / 2);
}

export function flightConvenience(f: FlightOption, shortestMin: number): number {
  const stops = clamp01(1 - 0.35 * f.attrs.stops);
  const duration = clamp01(shortestMin / f.attrs.duration_min);
  const arrival = hhmm(f.attrs.arrive_at);
  const civilized = arrival >= "08:00" && arrival <= "22:00" ? 1 : 0;
  return 0.4 * stops + 0.4 * duration + 0.2 * civilized;
}

/** Closeness to where the activities are; falls back to the city center. */
export function hotelLocation(
  h: HotelOption,
  activityCenter: LatLng | null,
  cityCenter: LatLng,
): number {
  const km =
    activityCenter && h.location
      ? haversineKm(h.location, activityCenter)
      : (h.attrs.km_from_center ?? (h.location ? haversineKm(h.location, cityCenter) : undefined));
  return km === undefined ? 0.5 : clamp01(1 - km / 5);
}

const matches = (a: ActivityOption, interests: readonly string[]) =>
  a.attrs.tags.some((t) => interests.includes(t));

export function prefMatch(chosen: ActivityOption[], interests: readonly string[]): number {
  if (interests.length === 0) return 1;
  if (chosen.length === 0) return 0;
  return chosen.filter((a) => matches(a, interests)).length / chosen.length;
}

/**
 * Greedy fill by value per dollar, where value favors matching interests and high ratings.
 * Stays under `remaining` and at most `slots` activities.
 */
export function fillActivities(
  activities: ActivityOption[],
  c: Constraints,
  remaining: number,
  slots: number,
): ActivityOption[] {
  const value = (a: ActivityOption) =>
    ((matches(a, c.activities.interests) ? 1 : 0.25) * (a.rating ?? 3.5)) /
    Math.max(activityTotal(a, c.travelers), 1);
  const ranked = [...activities].sort((a, b) => value(b) - value(a) || a.id.localeCompare(b.id));
  const chosen: ActivityOption[] = [];
  let left = remaining;
  for (const a of ranked) {
    if (chosen.length >= slots) break;
    const cost = activityTotal(a, c.travelers);
    if (cost <= left) {
      chosen.push(a);
      left -= cost;
    }
  }
  return chosen;
}

function centroid(points: LatLng[]): LatLng | null {
  if (points.length === 0) return null;
  const sum = points.reduce((s, p) => ({ lat: s.lat + p.lat, lng: s.lng + p.lng }), {
    lat: 0,
    lng: 0,
  });
  return { lat: sum.lat / points.length, lng: sum.lng / points.length };
}

export function packageId(flight: FlightOption, hotel: HotelOption): string {
  return `pkg_${createHash("sha256").update(`${flight.id}|${hotel.id}`).digest("hex").slice(0, 16)}`;
}

interface Candidate {
  flight: FlightOption;
  hotel: HotelOption;
  activities: ActivityOption[];
  total: number;
  breakdown: ScoreBreakdown;
  score: number;
}

/**
 * Joint optimizer (design.md §5.4): every flight × hotel pair on matching dates, activities
 * filled greedily under the remaining budget, then 2–3 distinct labeled packages.
 */
export function optimize(
  input: OptimizerInput,
  c: Constraints,
  weights: ScoreBreakdown = DEFAULT_WEIGHTS,
): OptimizeResult {
  const flights = input.flights.filter((f) => flightPasses(f, c));
  if (flights.length === 0) return { kind: "no_options", category: "flight" };
  const hotels = input.hotels.filter((h) => hotelPasses(h, c));
  if (hotels.length === 0) return { kind: "no_options", category: "hotel" };
  const activities = input.activities.filter((a) => activityPasses(a, c));

  const budget = c.budget.total_usd;
  const ceiling = budget * (1 + c.budget.tolerance_pct / 100);
  const shortest = Math.min(...flights.map((f) => f.attrs.duration_min));
  const activityCenter = centroid(activities.flatMap((a) => (a.location ? [a.location] : [])));
  const hotelsByPair = new Map<string, HotelOption[]>();
  for (const h of hotels)
    hotelsByPair.set(hotelPair(h), [...(hotelsByPair.get(hotelPair(h)) ?? []), h]);

  const candidates: Candidate[] = [];
  let pairedAny = false;
  for (const flight of flights) {
    for (const hotel of hotelsByPair.get(flightPair(flight)) ?? []) {
      pairedAny = true;
      const base = flightTotal(flight, c.travelers) + hotelTotal(hotel);
      if (base > ceiling) continue;
      const chosen = fillActivities(
        activities,
        c,
        Math.max(0, budget - base),
        c.activities.max_per_day * hotel.attrs.nights,
      );
      const total = round2(base + chosen.reduce((s, a) => s + activityTotal(a, c.travelers), 0));
      const breakdown: ScoreBreakdown = {
        cost_fit: round2(costFit(total, budget, c.budget.tolerance_pct)),
        flight_convenience: round2(flightConvenience(flight, shortest)),
        hotel_location: round2(hotelLocation(hotel, activityCenter, input.cityCenter)),
        rating: round2(clamp01((hotel.rating ?? 2.5) / 5)),
        pref_match: round2(prefMatch(chosen, c.activities.interests)),
      };
      const score =
        Math.round(
          (Object.keys(weights) as (keyof ScoreBreakdown)[]).reduce(
            (s, k) => s + weights[k] * breakdown[k],
            0,
          ) * 10_000,
        ) / 10_000;
      candidates.push({ flight, hotel, activities: chosen, total, breakdown, score });
    }
  }
  // Flights and hotels that never share a date pair can't form a trip.
  if (!pairedAny) return { kind: "no_options", category: "hotel" };
  if (candidates.length === 0) return { kind: "over_budget" };

  return { kind: "packages", packages: pickPackages(candidates) };
}

/**
 * best_value, then upgrade, then best_location; each a different flight + hotel pair, and a
 * different hotel property when one is available (the same hotel on other dates has a
 * different option ID but isn't a meaningfully different trip).
 */
function pickPackages(candidates: Candidate[]): TripPackage[] {
  const taken = new Set<string>();
  const hotelsUsed = new Set<string>();
  const key = (x: Candidate) => `${x.flight.id}|${x.hotel.id}`;
  const property = (x: Candidate) => x.hotel.title.toLowerCase();
  const tiebreak = (a: Candidate, b: Candidate) =>
    a.total - b.total || key(a).localeCompare(key(b));
  /** Tries each pool for an unused hotel first, then the first pool for anything unused. */
  const pick = (pools: Candidate[][], better: (a: Candidate, b: Candidate) => number) => {
    const open = (pool: Candidate[]) => pool.filter((x) => !taken.has(key(x)));
    const fresh = pools
      .map((p) => open(p).filter((x) => !hotelsUsed.has(property(x))))
      .find((p) => p.length);
    const best = (fresh ?? open(pools[0]!)).sort((a, b) => better(a, b) || tiebreak(a, b))[0];
    if (best) {
      taken.add(key(best));
      hotelsUsed.add(property(best));
    }
    return best;
  };

  const byScore = [...candidates].sort((a, b) => b.score - a.score || tiebreak(a, b));
  const topQuartile = byScore.slice(0, Math.max(1, Math.ceil(byScore.length / 4)));
  const topHalf = byScore.slice(0, Math.max(1, Math.ceil(byScore.length / 2)));

  // best_location is chosen first so its label stays true: picking it last would leave it
  // whichever hotel the other two didn't take. Top-quartile score per design.md §5.4.
  const location = pick(
    [topQuartile, topHalf],
    (a, b) => b.breakdown.hotel_location - a.breakdown.hotel_location,
  );
  const value = pick([candidates], (a, b) => b.score / b.total - a.score / a.total);
  const upgrade = pick([candidates], (a, b) => b.score - a.score);
  const picks: [PackageLabel, Candidate | undefined][] = [
    ["best_value", value],
    ["upgrade", upgrade],
    ["best_location", location],
  ];
  return picks.flatMap(([label, x]) =>
    x
      ? [
          {
            id: packageId(x.flight, x.hotel),
            label,
            flight: x.flight,
            hotel: x.hotel,
            activities: x.activities,
            total_usd: x.total,
            score: x.score,
            score_breakdown: x.breakdown,
          },
        ]
      : [],
  );
}
