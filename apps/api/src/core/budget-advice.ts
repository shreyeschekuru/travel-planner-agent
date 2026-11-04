import type { BudgetAdvice, Constraints, FlightOption, HotelOption } from "@travellite/schema";
import {
  flightPasses,
  flightTotal,
  hotelPasses,
  hotelTotal,
  type OptimizerInput,
} from "./optimizer.js";

export interface GridPair {
  depart: string;
  return: string;
  /** Days from the requested dates. */
  shift: number;
  flights: FlightOption[];
  hotels: HotelOption[];
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Cheapest flight + hotel on the same dates that pass the non-budget constraints. */
function cheapestCombo(flights: FlightOption[], hotels: HotelOption[], c: Constraints) {
  let best: { flight: number; hotel: number; total: number } | null = null;
  for (const f of flights) {
    if (!flightPasses(f, c)) continue;
    for (const h of hotels) {
      if (!hotelPasses(h, c)) continue;
      if (h.attrs.checkin !== f.attrs.depart_at.slice(0, 10)) continue;
      if (h.attrs.checkout !== f.attrs.return_depart_at.slice(0, 10)) continue;
      const flight = flightTotal(f, c.travelers);
      const hotel = hotelTotal(h);
      if (!best || flight + hotel < best.total) best = { flight, hotel, total: flight + hotel };
    }
  }
  return best;
}

/**
 * Advice when no package fits (design.md §5.4): the cheapest possible total, which category
 * drives it, and the closest cached date pair that would fit. Code only, no LLM call.
 */
export function budgetAdvice(
  input: OptimizerInput,
  c: Constraints,
  grid: GridPair[],
): BudgetAdvice {
  const cheapest = cheapestCombo(input.flights, input.hotels, c);
  const ceiling = c.budget.total_usd * (1 + c.budget.tolerance_pct / 100);

  const fitting = grid
    .map((g) => ({ g, combo: cheapestCombo(g.flights, g.hotels, c) }))
    .filter((x) => x.combo && x.combo.total <= ceiling)
    .sort(
      (a, b) => Math.abs(a.g.shift) - Math.abs(b.g.shift) || a.combo!.total - b.combo!.total,
    )[0];

  return {
    cheapest_total_usd: round2(cheapest?.total ?? 0),
    driver: cheapest && cheapest.hotel > cheapest.flight ? "hotel" : "flight",
    ...(fitting
      ? {
          nearest_fitting_dates: {
            depart: fitting.g.depart,
            return: fitting.g.return,
            total_usd: round2(fitting.combo!.total),
          },
        }
      : {}),
  };
}
