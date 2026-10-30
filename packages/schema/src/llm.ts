import { z } from "zod";

/** A statement the LLM makes, with the input fields it is based on (for grounding). */
export const Claim = z.object({
  text: z.string().min(1).max(200),
  source_fields: z.array(z.string().min(1).max(100)).min(1).max(5),
});
export type Claim = z.infer<typeof Claim>;

export const PackageExplanation = z.object({
  package_id: z.string().min(1).max(64),
  headline: z.string().min(1).max(80),
  pros: z.array(Claim).min(2).max(3),
  cons: z.array(Claim).min(1).max(3),
});
export type PackageExplanation = z.infer<typeof PackageExplanation>;
