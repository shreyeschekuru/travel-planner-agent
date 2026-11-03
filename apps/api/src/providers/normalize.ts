import { Option, type LatLng } from "@travellite/schema";
import type { z } from "zod";

/** Booking links must be https and on one of these hosts. */
export const BOOKING_HOSTS = new Set(["www.google.com", "www.viator.com"]);

export function isAllowedBookingUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && BOOKING_HOSTS.has(u.hostname);
  } catch {
    return false;
  }
}

export interface Normalized {
  options: Option[];
  /** Items dropped because they failed validation, conversion or the URL allowlist. */
  dropped: number;
}

/**
 * Validates each raw item, maps it, then validates the result. Bad items are dropped and
 * counted rather than failing the whole search.
 */
export async function normalizeItems<R>(
  items: unknown[],
  rawSchema: z.ZodType<R>,
  map: (raw: R) => Promise<unknown | null> | unknown | null,
): Promise<Normalized> {
  const options: Option[] = [];
  let dropped = 0;
  for (const item of items) {
    const raw = rawSchema.safeParse(item);
    const mapped = raw.success ? await map(raw.data) : null;
    const parsed = mapped === null ? null : Option.safeParse(mapped);
    if (parsed?.success && isAllowedBookingUrl(parsed.data.url)) options.push(parsed.data);
    else dropped++;
  }
  return { options, dropped };
}

export const round2 = (n: number) => Math.round(n * 100) / 100;

/** Great-circle distance in km. */
export function haversineKm(a: LatLng, b: LatLng): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

/** ISO 8601 duration ("PT2H26M", "P1DT3H") to minutes. */
export function isoDurationMinutes(d: string): number | null {
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:\d+(?:\.\d+)?S)?)?$/.exec(d);
  if (!m || d === "P" || d === "PT") return null;
  const [, days = "0", hours = "0", mins = "0"] = m;
  return Number(days) * 1440 + Number(hours) * 60 + Number(mins);
}

export function nightsBetween(checkin: string, checkout: string): number {
  return Math.round(
    (Date.parse(`${checkout}T00:00:00Z`) - Date.parse(`${checkin}T00:00:00Z`)) / 86_400_000,
  );
}
