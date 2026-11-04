import {
  Constraints,
  MAX_BUDGET_USD,
  MAX_DAYS_AHEAD,
  MIN_BUDGET_USD,
  Preference,
  type ConstraintDelta,
  type DeltaOp,
  type DeltaPath,
  type OptionCategory,
  type RefineChip,
} from "@travellite/schema";

const DAY_MS = 86_400_000;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** JSON with sorted keys, so field order doesn't count as a change. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}

const usd = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;

export interface ChipContext {
  /** Cheapest per-night price among the hotels currently shown, if any. */
  hotelPerNight?: number;
  /**
   * Per-night prices of every hotel in the results that passes the other hotel constraints.
   * Lets cheaper_hotel aim for a price that some hotel actually has.
   */
  eligiblePerNight?: number[];
}

/**
 * A per-night cap about 20% under `reference`; when no eligible hotel is that cheap, the price
 * of the next cheaper one. Null when nothing cheaper exists.
 */
function cheaperCap(reference: number, eligible: number[] | undefined): number | null {
  const target = Math.floor(reference * 0.8);
  if (!eligible) return target;
  if (eligible.some((p) => p <= target)) return target;
  const next = Math.max(...eligible.filter((p) => p < reference));
  return Number.isFinite(next) ? Math.ceil(next) : null;
}

/**
 * The fixed delta for each chip (design.md §5.7). No LLM. Returns null when the chip has
 * nothing to work from (cheaper_hotel with no price cap and no hotel to compare against).
 */
export function chipDelta(
  chip: RefineChip,
  c: Constraints,
  ctx: ChipContext = {},
): ConstraintDelta | null {
  switch (chip) {
    case "cheaper_hotel": {
      // Compare against what's shown when possible: an existing cap may be far above it.
      const reference = ctx.hotelPerNight ?? c.hotel.max_price_per_night_usd;
      if (reference === undefined) return null;
      const cap = cheaperCap(reference, ctx.eligiblePerNight);
      if (cap === null) return null;
      return {
        ops: [{ path: "hotel.max_price_per_night_usd", op: "set", value: cap }],
        reason: `Hotel max price set to ${usd(cap)}/night`,
      };
    }
    case "better_hotel": {
      const ops: DeltaOp[] = [
        { path: "hotel.min_rating", op: "set", value: Math.min(5, c.hotel.min_rating + 0.5) },
      ];
      // A price cap would fight a higher rating, so lift it.
      if (c.hotel.max_price_per_night_usd !== undefined) {
        ops.push({ path: "hotel.max_price_per_night_usd", op: "remove", value: 0 });
      }
      return { ops, reason: `Hotels rated ${Math.min(5, c.hotel.min_rating + 0.5)}+ only` };
    }
    case "fewer_stops": {
      const stops = Math.max(0, c.flight.max_stops - 1);
      return {
        ops: [{ path: "flight.max_stops", op: "set", value: stops }],
        reason:
          stops === 0
            ? "Nonstop flights only"
            : `Flights with at most ${stops} stop${stops > 1 ? "s" : ""}`,
      };
    }
    case "shift_dates_earlier":
    case "shift_dates_later": {
      const days = chip === "shift_dates_earlier" ? -1 : 1;
      return {
        ops: [
          { path: "dates.depart", op: "add", value: days },
          { path: "dates.return", op: "add", value: days },
        ],
        reason: `Trip moved one day ${days < 0 ? "earlier" : "later"}`,
      };
    }
    case "more_activities": {
      const perDay = Math.min(6, c.activities.max_per_day + 1);
      return {
        ops: [{ path: "activities.max_per_day", op: "set", value: perDay }],
        reason: `Up to ${perDay} activities a day`,
      };
    }
  }
}

export type ApplyResult =
  { ok: true; constraints: Constraints; changed: boolean } | { ok: false; error: string };

type Kind = "money" | "rating" | "stops" | "perDay" | "km" | "date" | "time" | "interests";

const FIELD: Record<DeltaPath, { kind: Kind; optional: boolean }> = {
  "budget.total_usd": { kind: "money", optional: false },
  "dates.depart": { kind: "date", optional: false },
  "dates.return": { kind: "date", optional: false },
  "flight.max_stops": { kind: "stops", optional: false },
  "flight.max_price_usd": { kind: "money", optional: true },
  "flight.earliest_depart": { kind: "time", optional: true },
  "flight.latest_arrive": { kind: "time", optional: true },
  "hotel.min_rating": { kind: "rating", optional: false },
  "hotel.max_price_per_night_usd": { kind: "money", optional: true },
  "hotel.max_km_from_center": { kind: "km", optional: true },
  "activities.interests": { kind: "interests", optional: false },
  "activities.max_per_day": { kind: "perDay", optional: false },
  "activities.max_price_each_usd": { kind: "money", optional: true },
};

const addDays = (iso: string, days: number) =>
  new Date(Date.parse(`${iso}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);

function applyOp(current: unknown, op: DeltaOp, kind: Kind, optional: boolean): unknown | Error {
  const { value } = op;
  if (op.op === "remove") {
    if (kind === "interests") {
      const drop = Array.isArray(value) ? value : [value];
      return (current as string[]).filter((p) => !drop.includes(p));
    }
    if (!optional) return new Error(`${op.path} can't be removed`);
    return undefined;
  }
  if (kind === "interests") {
    const items = Array.isArray(value) ? value : [value];
    if (!items.every((i) => Preference.safeParse(i).success)) return new Error("Unknown interest");
    if (op.op === "set") return [...new Set(items)];
    if (op.op === "add") return [...new Set([...(current as string[]), ...items])];
    return new Error(`Can't ${op.op} interests`);
  }
  if (kind === "date") {
    if (op.op === "set")
      return typeof value === "string" && ISO_DATE.test(value)
        ? value
        : new Error("Expected a date");
    if (op.op === "add" && Number.isInteger(value))
      return addDays(current as string, value as number);
    return new Error(`Can't ${op.op} a date`);
  }
  if (kind === "time") {
    if (op.op === "set" && typeof value === "string" && HHMM.test(value)) return value;
    return new Error("Expected a time like 09:00");
  }
  // Numbers.
  if (typeof value !== "number" || !Number.isFinite(value))
    return new Error(`${op.path} needs a number`);
  if (op.op === "set") return value;
  if (current === undefined) return new Error(`${op.path} has no value to ${op.op}`);
  if (op.op === "add") return (current as number) + value;
  if (value <= 0 || value > 10) return new Error("Scale factor out of range");
  return (current as number) * value;
}

function normalize(kind: Kind, v: unknown): unknown {
  if (typeof v !== "number") return v;
  switch (kind) {
    case "money":
      return Math.round(v * 100) / 100;
    case "rating":
      return Math.round(v * 10) / 10;
    case "km":
      return Math.round(v * 10) / 10;
    case "stops":
    case "perDay":
      return Math.round(v);
    default:
      return v;
  }
}

function boundsError(c: Constraints, now: Date): string | null {
  const today = now.toISOString().slice(0, 10);
  const latest = new Date(now.getTime() + MAX_DAYS_AHEAD * DAY_MS).toISOString().slice(0, 10);
  if (c.dates.depart < today) return "The trip would start in the past";
  if (c.dates.depart > latest) return `Trips must start within ${MAX_DAYS_AHEAD} days`;
  if (c.dates.return <= c.dates.depart) return "Return must be after departure";
  if (c.budget.total_usd < MIN_BUDGET_USD || c.budget.total_usd > MAX_BUDGET_USD) {
    return `Budget must be between ${usd(MIN_BUDGET_USD)} and ${usd(MAX_BUDGET_USD)}`;
  }
  for (const v of [
    c.flight.max_price_usd,
    c.hotel.max_price_per_night_usd,
    c.activities.max_price_each_usd,
  ]) {
    if (v !== undefined && v <= 0) return "Prices must be above $0";
  }
  if (c.hotel.max_km_from_center !== undefined && c.hotel.max_km_from_center <= 0)
    return "Distance must be above 0";
  return null;
}

/**
 * Applies a delta to constraints (design.md §5.7). Pure: returns new constraints, or an error
 * when an op doesn't fit its field or the result breaks a bound. `changed` is false for a
 * delta that leaves everything as it was.
 */
export function applyDelta(c: Constraints, delta: ConstraintDelta, now = new Date()): ApplyResult {
  const next = structuredClone(c) as Constraints;
  for (const op of delta.ops) {
    const field = FIELD[op.path];
    if (!field) return { ok: false, error: `Can't change ${op.path}` };
    const [group, key] = op.path.split(".") as [keyof Constraints, string];
    const target = next[group] as Record<string, unknown>;
    const result = applyOp(target[key], op, field.kind, field.optional);
    if (result instanceof Error) return { ok: false, error: result.message };
    if (result === undefined) delete target[key];
    else target[key] = normalize(field.kind, result);
  }
  const parsed = Constraints.safeParse(next);
  if (!parsed.success) return { ok: false, error: "That change is out of range" };
  const bound = boundsError(parsed.data, now);
  if (bound) return { ok: false, error: bound };
  return { ok: true, constraints: parsed.data, changed: canonical(parsed.data) !== canonical(c) };
}

/**
 * Categories whose search results a delta invalidates (design.md §5.7). Only date changes
 * alter search keys; other paths only change what the optimizer accepts.
 */
export function invalidated(delta: ConstraintDelta): Set<OptionCategory> {
  const out = new Set<OptionCategory>();
  for (const { path } of delta.ops) {
    if (path.startsWith("dates.")) return new Set(["flight", "hotel", "activity"]);
    if (path.startsWith("flight.")) out.add("flight");
    if (path.startsWith("hotel.")) out.add("hotel");
    if (path.startsWith("activities.")) out.add("activity");
  }
  return out;
}
