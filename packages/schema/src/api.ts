import { z } from "zod";
import { CityId, IATA, ISODate } from "./primitives.js";
import { MAX_REFINE_TEXT, RefineChip } from "./refine.js";
import { MAX_TRAVELERS } from "./trip.js";

export const InstallRequest = z.object({
  extension_version: z.string().regex(/^\d+\.\d+\.\d+$/),
});
export type InstallRequest = z.infer<typeof InstallRequest>;

export const InstallResponse = z.object({ install_token: z.string() });
export type InstallResponse = z.infer<typeof InstallResponse>;

export const PrefetchRequest = z.object({
  origin: IATA,
  destination: CityId,
  departure_date: ISODate,
  return_date: ISODate,
  date_flex_days: z.union([z.literal(0), z.literal(1), z.literal(2)]),
  travelers: z.number().int().min(1).max(MAX_TRAVELERS),
});
export type PrefetchRequest = z.infer<typeof PrefetchRequest>;

export const CreateSessionResponse = z.object({
  session_id: z.uuid(),
  stream_url: z.string(),
});
export type CreateSessionResponse = z.infer<typeof CreateSessionResponse>;

export const RefineRequest = z.union([
  z.object({ chip: RefineChip }).strict(),
  z.object({ text: z.string().min(1).max(MAX_REFINE_TEXT) }).strict(),
]);
export type RefineRequest = z.infer<typeof RefineRequest>;

export const SelectRequest = z.object({ package_id: z.string().min(1).max(64) }).strict();
export type SelectRequest = z.infer<typeof SelectRequest>;

export const HealthResponse = z.object({ status: z.literal("ok") });
