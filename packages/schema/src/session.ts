import { z } from "zod";
import { PackageExplanation } from "./llm.js";
import { TripPackage } from "./packages.js";
import { ISODateTime } from "./primitives.js";
import { ConstraintDelta, MAX_REFINEMENTS } from "./refine.js";
import { Constraints, VacationConfigShape } from "./trip.js";

export const SessionStatus = z.enum([
  "searching",
  "awaiting_selection",
  "refining",
  "selected",
  "failed",
]);
export type SessionStatus = z.infer<typeof SessionStatus>;

const CategoryResult = z.object({
  option_ids: z.array(z.string()),
  fetched_at: ISODateTime,
  degraded: z.boolean(),
});

export const SessionRecord = z.object({
  id: z.uuid(),
  install_id: z.string().min(1).max(64),
  status: SessionStatus,
  config: VacationConfigShape,
  constraints: Constraints,
  delta_history: z.array(ConstraintDelta).max(MAX_REFINEMENTS),
  results: z.object({
    flight: CategoryResult.optional(),
    hotel: CategoryResult.optional(),
    activity: CategoryResult.optional(),
  }),
  packages: z.array(TripPackage),
  explanations: z.array(PackageExplanation),
  created_at: ISODateTime,
});
export type SessionRecord = z.infer<typeof SessionRecord>;

export const SESSION_TTL_SECONDS = 24 * 60 * 60;
