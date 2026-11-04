import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Constraints } from "@travellite/schema";
import { buildConstraints } from "../src/core/constraints.js";
import { findFixturesDir } from "../src/providers/fixtures.js";

/** Loader and grader for evals/parse-delta.json, shared by the unit and live tests. */
interface EvalFile {
  trip: {
    depart_in_days: number;
    nights: number;
    budget_usd: number;
    travelers: number;
    preferences: string[];
  };
  context: { hotel_per_night: number };
  cases: { text: string; expect: Record<string, unknown> | null }[];
}

const DAY_MS = 86_400_000;
const addDays = (iso: string, days: number) =>
  new Date(Date.parse(`${iso}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);

export function loadParseDeltaEval(now = new Date()) {
  const path = join(findFixturesDir(), "..", "evals", "parse-delta.json");
  const file = JSON.parse(readFileSync(path, "utf8")) as EvalFile;
  const depart = addDays(now.toISOString().slice(0, 10), file.trip.depart_in_days);
  const constraints = buildConstraints({
    origin: "JFK",
    destination: "lisbon-pt",
    departure_date: depart,
    return_date: addDays(depart, file.trip.nights),
    date_flex_days: 0,
    budget_usd: file.trip.budget_usd,
    travelers: file.trip.travelers,
    preferences: file.trip.preferences as Constraints["activities"]["interests"],
  });
  const expected = (expect: Record<string, unknown>): Constraints => {
    const c = structuredClone(constraints) as Constraints;
    for (const [path, value] of Object.entries(expect)) {
      const [group, key] = path.split(".") as [keyof Constraints, string];
      const target = c[group] as Record<string, unknown>;
      const days = (value as { days?: number })?.days;
      target[key] = typeof days === "number" ? addDays(target[key] as string, days) : value;
    }
    return c;
  };
  return {
    constraints,
    context: {
      today: now.toISOString().slice(0, 10),
      hotel_per_night: file.context.hotel_per_night,
    },
    cases: file.cases.map((c) => ({
      text: c.text,
      expected: c.expect ? expected(c.expect) : null,
    })),
  };
}

/** Sorted-key JSON, so the grader ignores field order. */
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}
