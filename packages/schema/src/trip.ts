import { z } from "zod";
import { CityId, HHMM, IATA, ISODate } from "./primitives.js";

export const Preference = z.enum([
  "beach",
  "museums",
  "food",
  "nightlife",
  "outdoors",
  "shopping",
  "family",
  "relaxed_pace",
]);
export type Preference = z.infer<typeof Preference>;

export const MAX_TRAVELERS = 9;
export const MIN_BUDGET_USD = 100;
export const MAX_BUDGET_USD = 100_000;
export const MAX_DAYS_AHEAD = 365;

/**
 * Structural shape of the trip form. Use `parseVacationConfig` for full validation,
 * which also checks date ordering and the booking window.
 */
export const VacationConfigShape = z.object({
  origin: IATA,
  destination: CityId,
  departure_date: ISODate,
  return_date: ISODate,
  date_flex_days: z.union([z.literal(0), z.literal(1), z.literal(2)]),
  budget_usd: z.number().min(MIN_BUDGET_USD).max(MAX_BUDGET_USD),
  travelers: z.number().int().min(1).max(MAX_TRAVELERS),
  preferences: z.array(Preference).max(Preference.options.length),
});
export type VacationConfig = z.infer<typeof VacationConfigShape>;

const DAY_MS = 86_400_000;
const utcDay = (iso: string) => Date.parse(`${iso}T00:00:00Z`);

/** Full validation, including rules that depend on the current date. */
export function vacationConfigSchema(now: Date = new Date()) {
  const today = utcDay(now.toISOString().slice(0, 10));
  return VacationConfigShape.superRefine((c, ctx) => {
    const dep = utcDay(c.departure_date);
    const ret = utcDay(c.return_date);
    if (ret <= dep) {
      ctx.addIssue({
        code: "custom",
        path: ["return_date"],
        message: "Return must be after departure",
      });
    }
    if (dep < today) {
      ctx.addIssue({
        code: "custom",
        path: ["departure_date"],
        message: "Departure is in the past",
      });
    }
    if (dep > today + MAX_DAYS_AHEAD * DAY_MS) {
      ctx.addIssue({
        code: "custom",
        path: ["departure_date"],
        message: `Departure must be within ${MAX_DAYS_AHEAD} days`,
      });
    }
    if (new Set(c.preferences).size !== c.preferences.length) {
      ctx.addIssue({ code: "custom", path: ["preferences"], message: "Duplicate preferences" });
    }
  });
}

export function parseVacationConfig(input: unknown, now: Date = new Date()) {
  return vacationConfigSchema(now).safeParse(input);
}

export const Constraints = z.object({
  dates: z.object({ depart: ISODate, return: ISODate, flex_days: z.number().int().min(0).max(2) }),
  budget: z.object({
    total_usd: z.number().positive(),
    tolerance_pct: z.number().min(0).max(25),
  }),
  flight: z.object({
    max_stops: z.number().int().min(0).max(3),
    max_price_usd: z.number().positive().optional(),
    earliest_depart: HHMM.optional(),
    latest_arrive: HHMM.optional(),
  }),
  hotel: z.object({
    min_rating: z.number().min(0).max(5),
    max_price_per_night_usd: z.number().positive().optional(),
    max_km_from_center: z.number().positive().optional(),
  }),
  activities: z.object({
    interests: z.array(Preference),
    max_per_day: z.number().int().min(0).max(6),
    max_price_each_usd: z.number().positive().optional(),
  }),
  travelers: z.number().int().min(1).max(MAX_TRAVELERS),
});
export type Constraints = z.infer<typeof Constraints>;
