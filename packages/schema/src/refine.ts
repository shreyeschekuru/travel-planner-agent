import { z } from "zod";

export const RefineChip = z.enum([
  "cheaper_hotel",
  "better_hotel",
  "fewer_stops",
  "shift_dates_earlier",
  "shift_dates_later",
  "more_activities",
]);
export type RefineChip = z.infer<typeof RefineChip>;

/** Constraint paths a delta may touch. Anything else is rejected. */
export const DeltaPath = z.enum([
  "budget.total_usd",
  "dates.depart",
  "dates.return",
  "flight.max_stops",
  "flight.max_price_usd",
  "flight.earliest_depart",
  "flight.latest_arrive",
  "hotel.min_rating",
  "hotel.max_price_per_night_usd",
  "hotel.max_km_from_center",
  "activities.interests",
  "activities.max_per_day",
  "activities.max_price_each_usd",
]);
export type DeltaPath = z.infer<typeof DeltaPath>;

export const DeltaOp = z.object({
  path: DeltaPath,
  op: z.enum(["set", "scale", "add", "remove"]),
  value: z.union([z.number(), z.string().max(64), z.array(z.string().max(32)).max(8)]),
});
export type DeltaOp = z.infer<typeof DeltaOp>;

export const ConstraintDelta = z.object({
  ops: z.array(DeltaOp).min(1).max(5),
  /** Shown to the user, e.g. "Hotel max price lowered to $120/night". */
  reason: z.string().min(1).max(160),
});
export type ConstraintDelta = z.infer<typeof ConstraintDelta>;

export const MAX_REFINEMENTS = 10;
export const MAX_REFINE_TEXT = 200;
