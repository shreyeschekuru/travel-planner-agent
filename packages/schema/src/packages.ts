import { z } from "zod";
import { ActivityOption, FlightOption, HotelOption } from "./options.js";
import { ISODate } from "./primitives.js";

export const PackageLabel = z.enum(["best_value", "best_location", "upgrade"]);
export type PackageLabel = z.infer<typeof PackageLabel>;

const unit = z.number().min(0).max(1);

export const ScoreBreakdown = z.object({
  cost_fit: unit,
  flight_convenience: unit,
  hotel_location: unit,
  rating: unit,
  pref_match: unit,
});
export type ScoreBreakdown = z.infer<typeof ScoreBreakdown>;

export const TripPackage = z.object({
  id: z.string().min(1).max(64),
  label: PackageLabel,
  flight: FlightOption,
  hotel: HotelOption,
  activities: z.array(ActivityOption),
  total_usd: z.number().nonnegative(),
  score: z.number(),
  score_breakdown: ScoreBreakdown,
});
export type TripPackage = z.infer<typeof TripPackage>;

export const BudgetAdvice = z.object({
  /** Cheapest flight + hotel on the same dates that pass every other constraint. */
  cheapest_total_usd: z.number().nonnegative(),
  driver: z.enum(["flight", "hotel", "activities"]),
  cheapest_flight_usd: z.number().nonnegative().optional(),
  cheapest_hotel_usd: z.number().nonnegative().optional(),
  nights: z.number().int().positive().optional(),
  /** Non-default constraints that shaped the cheapest total, e.g. "hotels rated 4.5+". */
  filters: z.array(z.string().max(80)).max(10).optional(),
  nearest_fitting_dates: z
    .object({ depart: ISODate, return: ISODate, total_usd: z.number().nonnegative() })
    .optional(),
});
export type BudgetAdvice = z.infer<typeof BudgetAdvice>;
