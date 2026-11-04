import type { Constraints, VacationConfig } from "@travellite/schema";

export const DEFAULTS = {
  max_stops: 1,
  min_rating: 3.5,
  max_per_day: 2,
  relaxed_max_per_day: 1,
  tolerance_pct: 5,
} as const;

/** Turns the trip form into hard constraints. Pure; see design.md §5.1. */
export function buildConstraints(config: VacationConfig): Constraints {
  const relaxed = config.preferences.includes("relaxed_pace");
  return {
    dates: {
      depart: config.departure_date,
      return: config.return_date,
      flex_days: config.date_flex_days,
    },
    budget: { total_usd: config.budget_usd, tolerance_pct: DEFAULTS.tolerance_pct },
    flight: { max_stops: DEFAULTS.max_stops },
    hotel: { min_rating: DEFAULTS.min_rating },
    activities: {
      interests: [...config.preferences],
      max_per_day: relaxed ? DEFAULTS.relaxed_max_per_day : DEFAULTS.max_per_day,
    },
    travelers: config.travelers,
  };
}
