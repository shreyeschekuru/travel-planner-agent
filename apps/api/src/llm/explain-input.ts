import type { Constraints, TripPackage } from "@travellite/schema";

/** What the model sees for one package. Short keys keep input tokens down. */
export interface CompactPackage {
  id: string;
  label: string;
  total: number;
  budget: number;
  budget_pct: number;
  fl: { carrier: string; stops: number; dur: string; dep: string; arr: string; price: number };
  ht: {
    name: string;
    rating?: number;
    km?: number;
    nights: number;
    price: number;
    per_night: number;
  };
  acts: { title: string; tags: string[]; price_pp: number }[];
  n_acts: number;
  n_match: number;
  /** Score components, 0–100. */
  sc: Record<string, number>;
}

export function formatDuration(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h}h${String(m).padStart(2, "0")}m` : `${h}h`;
}

const whole = (n: number) => Math.round(n);
const one = (n: number) => Math.round(n * 10) / 10;

export function compactPackage(p: TripPackage, c: Constraints): CompactPackage {
  const interests: readonly string[] = c.activities.interests;
  const flightPrice =
    p.flight.price_basis === "per_person"
      ? p.flight.price.amount * c.travelers
      : p.flight.price.amount;
  const hotelPrice =
    p.hotel.price_basis === "per_night"
      ? p.hotel.price.amount * p.hotel.attrs.nights
      : p.hotel.price.amount;
  return {
    id: p.id,
    label: p.label,
    total: whole(p.total_usd),
    budget: whole(c.budget.total_usd),
    budget_pct: whole((p.total_usd / c.budget.total_usd) * 100),
    fl: {
      carrier: p.flight.attrs.carrier,
      stops: p.flight.attrs.stops,
      dur: formatDuration(p.flight.attrs.duration_min),
      dep: p.flight.attrs.depart_at.slice(0, 16).replace("T", " "),
      arr: p.flight.attrs.arrive_at.slice(0, 16).replace("T", " "),
      price: whole(flightPrice),
    },
    ht: {
      name: p.hotel.title,
      ...(p.hotel.rating === undefined ? {} : { rating: one(p.hotel.rating) }),
      ...(p.hotel.attrs.km_from_center === undefined
        ? {}
        : { km: one(p.hotel.attrs.km_from_center) }),
      nights: p.hotel.attrs.nights,
      price: whole(hotelPrice),
      per_night: whole(hotelPrice / p.hotel.attrs.nights),
    },
    acts: p.activities.map((a) => ({
      title: a.title,
      tags: a.attrs.tags,
      price_pp: whole(a.price.amount),
    })),
    n_acts: p.activities.length,
    n_match: p.activities.filter((a) => a.attrs.tags.some((t) => interests.includes(t))).length,
    sc: Object.fromEntries(Object.entries(p.score_breakdown).map(([k, v]) => [k, whole(v * 100)])),
  };
}
