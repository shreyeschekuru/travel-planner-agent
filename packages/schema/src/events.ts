import { z } from "zod";
import { ErrorCode } from "./errors.js";
import { PackageExplanation } from "./llm.js";
import { OptionCategory, ProviderErrorKind } from "./options.js";
import { BudgetAdvice, TripPackage } from "./packages.js";
import { ConstraintDelta } from "./refine.js";

/** Server-sent events. `event` is the SSE event name; `data` is the JSON payload. */
export const SessionEvent = z.discriminatedUnion("event", [
  z.object({
    event: z.literal("results"),
    data: z.object({ category: OptionCategory, count: z.number().int().nonnegative() }),
  }),
  z.object({
    event: z.literal("degraded"),
    data: z.object({
      category: OptionCategory,
      error_kind: ProviderErrorKind,
    }),
  }),
  z.object({ event: z.literal("packages"), data: z.array(TripPackage) }),
  z.object({ event: z.literal("explanation"), data: PackageExplanation }),
  z.object({ event: z.literal("budget_advice"), data: BudgetAdvice }),
  z.object({ event: z.literal("awaiting_selection"), data: z.object({}) }),
  z.object({
    event: z.literal("refine_applied"),
    data: z.object({ delta: ConstraintDelta, changed: z.boolean() }),
  }),
  z.object({
    event: z.literal("error"),
    data: z.object({
      code: ErrorCode,
      /** Names the exact cause, e.g. "No hotels rated 4.5+ (the highest rated is 4.2)". */
      message: z.string().max(300),
      /** Sending the same request again may work (a timeout, a busy provider). */
      retryable: z.boolean(),
      /** A refinement can fix it (a constraint, the dates); the session stays open for one. */
      refinable: z.boolean().optional(),
      /** The category that caused it, when there is one. */
      category: OptionCategory.optional(),
    }),
  }),
]);
export type SessionEvent = z.infer<typeof SessionEvent>;
export type SessionEventName = SessionEvent["event"];
