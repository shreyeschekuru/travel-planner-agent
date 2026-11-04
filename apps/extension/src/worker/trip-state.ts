import {
  MAX_REFINEMENTS,
  type ApiError,
  type BudgetAdvice,
  type ConstraintDelta,
  type OptionCategory,
  type PackageExplanation,
  type ProviderErrorKind,
  type SessionEvent,
  type TripPackage,
  type VacationConfig,
} from "@travellite/schema";

/**
 * - searching: first run, before packages.
 * - explaining: packages shown, explanations streaming.
 * - refining: a refinement is being applied.
 * - ready / advice / error: nothing running; the user can refine, select or start over.
 */
export type TripPhase = "searching" | "explaining" | "refining" | "ready" | "advice" | "error";

export type CategoryStatus = { count: number } | { degraded: ProviderErrorKind };

/** Everything the popup renders for the current trip. Stored in chrome.storage.session. */
export interface TripState {
  session_id: string;
  config: VacationConfig;
  /** Budget and dates after refinements; the rest of the config doesn't change. */
  current: { budget_usd: number; departure_date: string; return_date: string };
  last_event_id: string | null;
  phase: TripPhase;
  results: Partial<Record<OptionCategory, CategoryStatus>>;
  packages: TripPackage[];
  explanations: Record<string, PackageExplanation>;
  budget_advice: BudgetAdvice | null;
  error: ApiError | null;
  refinements: {
    count: number;
    last: { reason: string; changed: boolean } | null;
    /** The delta being applied, so cards can show which parts are updating. */
    pending: ConstraintDelta | null;
  };
  connection: "open" | "reconnecting" | "closed";
}

export function initialTrip(session_id: string, config: VacationConfig): TripState {
  return {
    session_id,
    config,
    current: {
      budget_usd: config.budget_usd,
      departure_date: config.departure_date,
      return_date: config.return_date,
    },
    last_event_id: null,
    phase: "searching",
    results: {},
    packages: [],
    explanations: {},
    budget_advice: null,
    error: null,
    refinements: { count: 0, last: null, pending: null },
    connection: "closed",
  };
}

/** Phases where the server is still working, so the event stream should stay open. */
export const isWorking = (phase: TripPhase) =>
  phase === "searching" || phase === "explaining" || phase === "refining";

export const canRefine = (s: TripState) =>
  !isWorking(s.phase) && s.refinements.count < MAX_REFINEMENTS;

/** Applies one session event. Pure. */
export function reduceTrip(s: TripState, e: SessionEvent): TripState {
  switch (e.event) {
    case "results":
      return { ...s, results: { ...s.results, [e.data.category]: { count: e.data.count } } };
    case "degraded":
      return {
        ...s,
        results: { ...s.results, [e.data.category]: { degraded: e.data.error_kind } },
      };
    case "packages":
      return {
        ...s,
        phase: "explaining",
        packages: e.data,
        explanations: {},
        budget_advice: null,
        error: null,
      };
    case "explanation":
      return { ...s, explanations: { ...s.explanations, [e.data.package_id]: e.data } };
    case "budget_advice":
      return {
        ...s,
        phase: "advice",
        packages: [],
        explanations: {},
        budget_advice: e.data,
        refinements: { ...s.refinements, pending: null },
      };
    case "awaiting_selection":
      return { ...s, phase: "ready", refinements: { ...s.refinements, pending: null } };
    case "refine_applied": {
      const last = { reason: e.data.delta.reason, changed: e.data.changed };
      if (!e.data.changed) return { ...s, refinements: { ...s.refinements, last } };
      return {
        ...s,
        phase: "refining",
        error: null,
        current: applyToSummary(s.current, e.data.delta),
        refinements: { count: s.refinements.count + 1, last, pending: e.data.delta },
      };
    }
    case "error":
      return {
        ...s,
        phase: "error",
        error: e.data,
        refinements: { ...s.refinements, pending: null },
      };
  }
}

const addDays = (iso: string, days: number) =>
  new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

/**
 * Applies a delta's budget and date ops to the summary the popup shows. The server already
 * validated the delta, so this only needs the arithmetic.
 */
export function applyToSummary(
  cur: TripState["current"],
  delta: ConstraintDelta,
): TripState["current"] {
  const next = { ...cur };
  for (const { path, op, value } of delta.ops) {
    if (path === "budget.total_usd" && typeof value === "number") {
      if (op === "set") next.budget_usd = value;
      if (op === "add") next.budget_usd += value;
      if (op === "scale") next.budget_usd = Math.round(next.budget_usd * value * 100) / 100;
    }
    const key =
      path === "dates.depart" ? "departure_date" : path === "dates.return" ? "return_date" : null;
    if (key) {
      if (op === "set" && typeof value === "string") next[key] = value;
      if (op === "add" && typeof value === "number") next[key] = addDays(next[key], value);
    }
  }
  return next;
}

/** Which parts of each card a pending delta will change (mirrors the API's invalidation). */
export function affectedParts(
  delta: ConstraintDelta | null,
): Set<"flight" | "hotel" | "activities" | "total"> {
  const out = new Set<"flight" | "hotel" | "activities" | "total">();
  if (!delta) return out;
  out.add("total");
  for (const { path } of delta.ops) {
    if (path.startsWith("dates.") || path.startsWith("budget.")) {
      out.add("flight").add("hotel").add("activities");
    }
    if (path.startsWith("flight.")) out.add("flight");
    if (path.startsWith("hotel.")) out.add("hotel");
    if (path.startsWith("activities.")) out.add("activities");
  }
  return out;
}
