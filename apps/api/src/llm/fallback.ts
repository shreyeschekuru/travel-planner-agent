import type { Claim, PackageExplanation, ScoreBreakdown } from "@travellite/schema";
import type { CompactPackage } from "./explain-input.js";

const usd = (n: number) => `$${n.toLocaleString("en-US")}`;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

type Component = keyof ScoreBreakdown;

function pro(k: Component, p: CompactPackage): Claim | null {
  switch (k) {
    case "cost_fit":
      return p.total <= p.budget
        ? {
            text: `Total ${usd(p.total)}, within your ${usd(p.budget)} budget`,
            source_fields: ["total", "budget"],
          }
        : {
            text: `Total ${usd(p.total)}, ${p.budget_pct}% of your budget`,
            source_fields: ["total", "budget_pct"],
          };
    case "flight_convenience":
      return p.fl.stops === 0
        ? { text: `Nonstop flight, ${p.fl.dur}`, source_fields: ["fl.stops", "fl.dur"] }
        : {
            text: `${plural(p.fl.stops, "stop")}, ${p.fl.dur} each way`,
            source_fields: ["fl.stops", "fl.dur"],
          };
    case "hotel_location":
      return p.ht.km === undefined
        ? null
        : { text: `Hotel is ${p.ht.km} km from the center`, source_fields: ["ht.km"] };
    case "rating":
      return p.ht.rating === undefined
        ? null
        : {
            text: `${p.ht.name} is rated ${p.ht.rating}/5`,
            source_fields: ["ht.name", "ht.rating"],
          };
    case "pref_match":
      return p.n_match > 0
        ? {
            text: `${plural(p.n_match, "activity", "activities")} matching your interests`,
            source_fields: ["n_match"],
          }
        : null;
  }
}

function con(k: Component, p: CompactPackage): Claim | null {
  switch (k) {
    case "cost_fit":
      if (p.total > p.budget)
        return {
          text: `${usd(p.total - p.budget)} over your budget`,
          source_fields: ["total", "budget"],
        };
      return { text: `Uses ${p.budget_pct}% of your budget`, source_fields: ["budget_pct"] };
    case "flight_convenience":
      return {
        text: `${plural(p.fl.stops, "stop")}, ${p.fl.dur} each way`,
        source_fields: ["fl.stops", "fl.dur"],
      };
    case "hotel_location":
      return p.ht.km === undefined
        ? null
        : { text: `Hotel is ${p.ht.km} km from the center`, source_fields: ["ht.km"] };
    case "rating":
      return p.ht.rating === undefined
        ? null
        : { text: `Hotel is rated ${p.ht.rating}/5`, source_fields: ["ht.rating"] };
    case "pref_match":
      return p.n_acts === 0
        ? { text: "No activities fit the remaining budget", source_fields: ["n_acts"] }
        : {
            text: `${p.n_match} of ${p.n_acts} activities match your interests`,
            source_fields: ["n_match", "n_acts"],
          };
  }
}

const HEADLINE: Record<string, string> = {
  best_value: "Best value",
  best_location: "Best location",
  upgrade: "Upgrade",
};

/** Code-generated pros and cons from the score breakdown, used when the LLM can't help. */
export function fallbackClaims(p: CompactPackage): { pros: Claim[]; cons: Claim[] } {
  const ranked = (Object.entries(p.sc) as [Component, number][]).sort((a, b) => b[1] - a[1]);
  const pros = ranked.flatMap(([k]) => pro(k, p) ?? []).slice(0, 3);
  const weakest = [...ranked].reverse().find(([k]) => con(k, p) !== null);
  const cons = weakest ? [con(weakest[0], p)!] : [con("flight_convenience", p)!];
  // Always at least two pros; the flight and the total are always available.
  for (const k of ["cost_fit", "flight_convenience"] as const) {
    if (pros.length >= 2) break;
    const c = pro(k, p);
    if (c && !pros.some((x) => x.text === c.text)) pros.push(c);
  }
  return { pros: pros.slice(0, 3), cons };
}

export function fallbackExplanation(p: CompactPackage): PackageExplanation {
  const { pros, cons } = fallbackClaims(p);
  const headline = `${HEADLINE[p.label] ?? "Package"}: ${p.ht.name}`;
  return { package_id: p.id, headline: headline.slice(0, 80), pros, cons };
}

/** Keeps grounded model claims, topping up from the fallback so the schema's minimums hold. */
export function topUp(
  p: CompactPackage,
  pros: Claim[],
  cons: Claim[],
): { pros: Claim[]; cons: Claim[] } {
  const fb = fallbackClaims(p);
  const fill = (have: Claim[], extra: Claim[], min: number) => {
    const out = [...have];
    for (const c of extra) {
      if (out.length >= min) break;
      if (!out.some((x) => x.text === c.text)) out.push(c);
    }
    return out.slice(0, 3);
  };
  return { pros: fill(pros, fb.pros, 2), cons: fill(cons, fb.cons, 1) };
}
