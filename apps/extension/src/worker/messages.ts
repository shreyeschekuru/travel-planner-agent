import type {
  ApiError,
  PrefetchRequest,
  RefineRequest,
  SavedItinerary,
  VacationConfig,
} from "@travellite/schema";
import type { TripState } from "./trip-state.js";

/** Messages from the popup to the service worker. */
export type WorkerRequest =
  | { type: "status" }
  | { type: "start"; config: VacationConfig }
  | { type: "prefetch"; req: PrefetchRequest }
  | { type: "refine"; body: RefineRequest }
  | { type: "select"; package_id: string }
  | { type: "reset" };

type Result<T> = { ok: true; value: T } | { ok: false; error: ApiError };

/** The worker's reply for each request type. */
export interface WorkerResponses {
  status: { registered: boolean; error?: string };
  start: Result<TripState>;
  prefetch: { ok: true };
  refine: Result<{ reason: string; changed: boolean }>;
  select: Result<SavedItinerary>;
  reset: { ok: true };
}

export type WorkerResponse<T extends WorkerRequest["type"]> = WorkerResponses[T];
