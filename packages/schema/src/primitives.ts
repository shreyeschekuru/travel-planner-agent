import { z } from "zod";

const isRealDate = (s: string) => {
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(s);
};

/** Calendar date, YYYY-MM-DD. */
export const ISODate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD")
  .refine(isRealDate, "Not a real calendar date");
export type ISODate = z.infer<typeof ISODate>;

/** Timestamp with timezone, e.g. 2026-12-01T09:30:00Z. */
export const ISODateTime = z.iso.datetime({ offset: true });
export type ISODateTime = z.infer<typeof ISODateTime>;

/**
 * Wall-clock time at the airport, with no offset, e.g. 2026-12-01T09:30:00.
 * Flight providers report local times this way.
 */
export const LocalDateTime = z.iso.datetime({ local: true });
export type LocalDateTime = z.infer<typeof LocalDateTime>;

/** 24-hour clock time, HH:MM. */
export const HHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Expected HH:MM");
export type HHMM = z.infer<typeof HHMM>;

/** IATA airport or city code. */
export const IATA = z.string().regex(/^[A-Z]{3}$/, "Expected a 3-letter IATA code");
export type IATA = z.infer<typeof IATA>;

/** Internal city identifier, e.g. "paris-fr". */
export const CityId = z
  .string()
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "Expected a lowercase slug")
  .max(64);
export type CityId = z.infer<typeof CityId>;

/** https URL only. Provider-domain allowlisting happens in the API, not here. */
export const HttpsUrl = z.url({ protocol: /^https$/ }).max(2048);
export type HttpsUrl = z.infer<typeof HttpsUrl>;

export const Money = z.object({
  amount: z.number().nonnegative(),
  currency: z.literal("USD"),
});
export type Money = z.infer<typeof Money>;

export const LatLng = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});
export type LatLng = z.infer<typeof LatLng>;
