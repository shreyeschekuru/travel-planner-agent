import { z } from "zod";
import { HttpsUrl, ISODate, ISODateTime, LatLng, Money } from "./primitives.js";
import { Preference } from "./trip.js";

export const OptionCategory = z.enum(["flight", "hotel", "activity"]);
export type OptionCategory = z.infer<typeof OptionCategory>;

export const PriceBasis = z.enum(["total", "per_night", "per_person"]);
export type PriceBasis = z.infer<typeof PriceBasis>;

export const FlightAttrs = z.object({
  depart_at: ISODateTime,
  arrive_at: ISODateTime,
  return_depart_at: ISODateTime,
  stops: z.number().int().min(0),
  duration_min: z.number().int().positive(),
  carrier: z.string().min(1).max(64),
});
export type FlightAttrs = z.infer<typeof FlightAttrs>;

export const HotelAttrs = z.object({
  checkin: ISODate,
  checkout: ISODate,
  nights: z.number().int().positive(),
  km_from_center: z.number().nonnegative().optional(),
});
export type HotelAttrs = z.infer<typeof HotelAttrs>;

export const ActivityAttrs = z.object({
  tags: z.array(Preference),
  duration_min: z.number().int().positive().optional(),
});
export type ActivityAttrs = z.infer<typeof ActivityAttrs>;

const optionBase = {
  /** Provider-prefixed, e.g. "amadeus:abc123". */
  id: z.string().regex(/^[a-z]+:[A-Za-z0-9._-]{1,128}$/),
  title: z.string().min(1).max(200),
  price: Money,
  price_basis: PriceBasis,
  rating: z.number().min(0).max(5).optional(),
  location: LatLng.optional(),
  url: HttpsUrl,
};

export const FlightOption = z.object({
  ...optionBase,
  category: z.literal("flight"),
  attrs: FlightAttrs,
});
export const HotelOption = z.object({
  ...optionBase,
  category: z.literal("hotel"),
  attrs: HotelAttrs,
});
export const ActivityOption = z.object({
  ...optionBase,
  category: z.literal("activity"),
  attrs: ActivityAttrs,
});
export type FlightOption = z.infer<typeof FlightOption>;
export type HotelOption = z.infer<typeof HotelOption>;
export type ActivityOption = z.infer<typeof ActivityOption>;

export const Option = z.discriminatedUnion("category", [FlightOption, HotelOption, ActivityOption]);
export type Option = z.infer<typeof Option>;
