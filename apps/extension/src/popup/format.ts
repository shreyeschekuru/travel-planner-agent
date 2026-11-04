import { cityById, type OptionCategory, type PackageLabel } from "@travellite/schema";

const usd0 = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});

export const money = (n: number) => usd0.format(Math.round(n));

export function duration(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

/** "Mar 10" from YYYY-MM-DD, without time-zone shifts. */
export function shortDate(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d!)).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

/** "Mar 10, 17:40" from an airport-local timestamp. */
export const localTime = (iso: string) => `${shortDate(iso)}, ${iso.slice(11, 16)}`;

export const stops = (n: number) => (n === 0 ? "Nonstop" : `${n} stop${n > 1 ? "s" : ""}`);

export const cityName = (id: string) => cityById(id)?.name ?? id;

export const LABELS: Record<PackageLabel, string> = {
  best_value: "Best value",
  best_location: "Best location",
  upgrade: "Upgrade",
};

export const CATEGORY_NAMES: Record<OptionCategory, string> = {
  flight: "Flights",
  hotel: "Hotels",
  activity: "Activities",
};
