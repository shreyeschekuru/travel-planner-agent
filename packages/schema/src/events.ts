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
    data: z.object({ code: ErrorCode, message: z.string().max(300), retryable: z.boolean() }),
  }),
]);
export type SessionEvent = z.infer<typeof SessionEvent>;
export type SessionEventName = SessionEvent["event"];
