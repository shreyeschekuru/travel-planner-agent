import { z } from "zod";

/**
 * Export a Zod schema as JSON Schema (draft-07, which Fastify's Ajv uses by default)
 * for structural route validation. Refinements are not exported; handlers still run
 * the Zod parse for semantic rules.
 */
export function toRouteSchema(schema: z.ZodType): Record<string, unknown> {
  return z.toJSONSchema(schema, { target: "draft-7", unrepresentable: "any" }) as Record<
    string,
    unknown
  >;
}
